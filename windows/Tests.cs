using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using AiYaoce;

internal static class Tests
{
    private static int checks;
    private static readonly DateTime Now = DateTime.UtcNow;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; Console.WriteLine("PASS " + name); }
    private static string Row(object row) { return Data.Json().Serialize(row) + "\n"; }
    private static string Count(int tokens) { return Row(new { type = "event_msg", timestamp = Now.ToString("o"), payload = new { type = "token_count", info = new { total_token_usage = new { input_tokens = tokens, output_tokens = 0 } } } }); }
    private static int Main()
    {
        string home = Path.Combine(Path.GetTempPath(), "ai-yaoce-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(home);
        try
        {
            var parsed = Tokens.Parse(new Dictionary<string, object> { { "input_tokens", 100 }, { "cached_input_tokens", 20 }, { "output_tokens", 10 } }, true);
            Check(parsed.Total == 110 && parsed.Input == 80 && parsed.Read == 20, "Codex包含缓存输入不重复相加");
            parsed = Tokens.Parse(new Dictionary<string, object> { { "input_tokens", 100 }, { "cache_read_input_tokens", 20 }, { "output_tokens", 10 } }, false);
            Check(parsed.Total == 130, "Claude缓存输入另计");
            var parser = new Parser("codex", "fixture"); parser.Consume(Count(10), Now); parser.Consume(Count(10), Now); parser.Consume(Count(20), Now);
            Check(parser.Records.Values.Sum(record => record.Tokens.Total) == 20, "累计快照去重");
            parser.Consume(Count(5), Now); parser.Consume(Count(21), Now);
            Check(parser.Records.Values.Sum(record => record.Tokens.Total) == 21, "累计回退不膨胀");
            parser.Consume("{bad", Now); Check(parser.Problems >= 2, "无效记录安全跳过");
            parser = new Parser("codex", "partial");
            parser.Consume(Row(new { type = "event_msg", timestamp = Now.ToString("o"), payload = new { type = "token_count", info = new { total_token_usage = new { input_tokens = 100 }, last_token_usage = new { input_tokens = 2 } } } }), Now);
            Check(parser.Records.Values.Sum(record => record.Tokens.Total) == 2, "部分历史首条不冒充完整计量");
            var claude = new Parser("claude", "test");
            string assistant = Row(new { type = "assistant", timestamp = Now.ToString("o"), sessionId = "session", message = new { id = "message", model = "claude-test", content = "NEVER_RETAIN_PROMPT", usage = new { input_tokens = 12, output_tokens = 5 } } });
            claude.Consume(assistant, Now); claude.Consume(assistant, Now);
            Check(claude.Records.Count == 1 && claude.Records.Values.First().Tokens.Total == 17, "Claude重复片段去重");
            Check(!Data.Json().Serialize(claude.Records).Contains("NEVER_RETAIN_PROMPT"), "计量缓存不保留正文");
            var domestic = new Parser("qwen-codex", "test"); domestic.Consume(Count(999), Now); Check(domestic.Records.Count == 0, "国产未知协议不冒充Codex");
            string directory = Path.Combine(home, ".codex", "sessions"); Directory.CreateDirectory(directory);
            string file = Path.Combine(directory, "session.jsonl"); File.WriteAllText(file, Count(10));
            var state = new FileState(file, "codex"); state.Read(Now, 8192, CancellationToken.None);
            Check(state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 10, "首轮磁盘读取");
            Check(state.Read(Now, 8192, CancellationToken.None) == 0, "未变日志不重复解析，仅校验小片段");
            File.AppendAllText(file, Count(20)); state.Read(Now, 8192, CancellationToken.None);
            Check(state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 20, "增量追加");
            File.WriteAllText(file, Count(3)); state.Read(Now, 8192, CancellationToken.None);
            Check(state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 3, "截断重建");
            DateTime previousStamp = File.GetLastWriteTimeUtc(file);
            File.WriteAllText(file, Count(4)); File.SetLastWriteTimeUtc(file, previousStamp); state.Read(Now, 8192, CancellationToken.None);
            Check(state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 4, "同长度同时间戳改写用边界采样重建");
            File.AppendAllText(file, Count(8).TrimEnd('\n')); state.Read(Now, 8192, CancellationToken.None);
            Check(state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 4, "不完整尾行等待追加");
            File.AppendAllText(file, "\n"); state.Read(Now, 8192, CancellationToken.None);
            Check(state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 8, "尾行完成后解析");
            File.AppendAllText(file, new string('x', 300000) + "\n" + Count(9)); state.Read(Now, 400000, CancellationToken.None);
            Check(state.Parser.Problems > 0 && state.Parser.Records.Values.Sum(record => record.Tokens.Total) == 9, "超长行跳过且恢复后续记录");
            var options = new Settings(); string settingsPath = Path.Combine(home, "native-settings.json"); Data.Save(settingsPath, options);
            options = Settings.Load(settingsPath); Check(options.Interval == 60 && options.Enabled.Count == 6, "默认设置与持久化");
            File.WriteAllText(settingsPath, "broken"); bool failed = false; try { Settings.Load(settingsPath); } catch { failed = true; }
            Check(failed && File.ReadAllText(settingsPath) == "broken", "损坏设置不覆盖");
            var monitor = new AiYaoce.Monitor(home, Path.Combine(home, "prices.json"), false);
            var result = monitor.Scan(options, CancellationToken.None);
            Check(result.Count == 6 && result.First(item => item.Source == "codex").TodayTokens == 9, "磁盘扫描快照");
            options.Enabled.Remove("codex"); result = monitor.Scan(options, CancellationToken.None);
            Check(!result.First(item => item.Source == "codex").Enabled && result.First(item => item.Source == "codex").Files == 0, "停用释放来源缓存");
            options.Enabled.Add("codex"); File.Delete(file); result = monitor.Scan(options, CancellationToken.None);
            Check(result.First(item => item.Source == "codex").TodayTokens == 0, "删除文件删除统计");
            Check(LocalAudit.Origin("https://user:SECRET@relay.example/private/SECRET?token=SECRET") == "https://relay.example", "端点脱敏移除凭据路径查询");
            Check(!Data.SafePath(@"\\network.invalid\share\session.jsonl"), "拒绝UNC路径，避免文件读取触发网络请求");
            failed = false; try { Settings.Load(@"\\network.invalid\share\settings.json"); } catch (InvalidDataException) { failed = true; }
            Check(failed, "读取设置前拒绝网络路径");
            failed = false; try { Data.Save(@"\\network.invalid\share\settings.json", options); } catch (IOException) { failed = true; }
            Check(failed, "写入设置前拒绝网络路径");
            string qwen = Path.Combine(home, ".qwen"); Directory.CreateDirectory(qwen);
            File.WriteAllText(Path.Combine(qwen, "settings.json"), "{\"logPrompts\":true,\"usageStatisticsEnabled\":false,\"base_url\":\"https://a:SECRET@relay.example/path/SECRET?token=SECRET\"}");
            var snapshot = new Snapshot(); LocalAudit.Read(home, Source.All.First(source => source.Id == "qwen-codex"), snapshot);
            Check(snapshot.Audit.Any(item => item.Contains("logPrompts = true")) && snapshot.Audit.Any(item => item.Contains("usageStatisticsEnabled = false")), "被动审计布尔值");
            Check(!Data.Json().Serialize(snapshot).Contains("SECRET"), "审计不披露端点密钥");
            Check(snapshot.Official == "", "无明确订阅字段隐藏");
            string codex = Path.Combine(home, ".codex");
            File.WriteAllText(Path.Combine(codex, "config.toml"), "base_url = \"https://api.openai.com/v1\"");
            File.WriteAllText(Path.Combine(codex, "subscription.json"), "{\"auth_mode\":\"subscription\",\"planExpiry\":\"2027-01-01T00:00:00Z\",\"quotaWindows\":[{\"name\":\"5h\",\"usedPercent\":25}]}");
            snapshot = new Snapshot(); LocalAudit.Read(home, Source.All[0], snapshot);
            Check(snapshot.Channel.Contains("官方订阅") && snapshot.Official.Contains("25%"), "明确本地官订字段");
            File.WriteAllText(Path.Combine(codex, "config.toml"), "base_url = \"https://relay.example/v1\"");
            snapshot = new Snapshot(); LocalAudit.Read(home, Source.All[0], snapshot); Check(snapshot.Official == "", "中转配置不冒充官订");
            var rates = new Pricing(); rates.Rules.Add(new Dictionary<string, object> { { "source", "claude" }, { "model", "claude-test" }, { "provider", "" }, { "prices", new Dictionary<string, object> { { "input", 0 }, { "output", 0 } } } });
            Check(rates.Cost("claude", claude.Records.Values.First()) == 0, "零单价保留");
            Check(rates.Cost("codex", claude.Records.Values.First()) == null, "价格来源隔离");
            claude.Records.Values.First().UnsupportedPrice = true; Check(rates.Cost("claude", claude.Records.Values.First()) == null, "未支持缓存价格不猜测");
            var cancellation = new CancellationTokenSource(); cancellation.Cancel(); failed = false;
            try { monitor.Scan(options, cancellation.Token); } catch (OperationCanceledException) { failed = true; }
            Check(failed, "扫描可取消");
            Console.WriteLine("PASS " + checks + " checks"); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { Directory.Delete(home, true); }
    }
}
