using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace AiYaoce
{
    public sealed class Source
    {
        public string Id, Name;
        public string[] Roots, Configs;
        public bool Usage;
        public Source(string id, string name, bool usage, string[] roots, params string[] configs)
        { Id = id; Name = name; Usage = usage; Roots = roots; Configs = configs; }
        public static readonly Source[] All = {
            new Source("codex", "Codex", true, new[] { ".codex/sessions", ".codex/archived_sessions" }, ".codex/config.toml"),
            new Source("claude", "Claude Code", true, new[] { ".claude/projects" }, ".claude/settings.json"),
            new Source("zcodex", "zCodex", false, new[] { ".zcode", ".zcodex" }, ".zcode/config.json", ".zcodex/config.json"),
            new Source("dsh-deepseek", "DSH DeepSeek", false, new[] { ".dsh", ".deepseek" }, ".dsh/settings.yaml"),
            new Source("qwen-codex", "Qwen Codex", false, new[] { ".qwen" }, ".qwen/settings.json", ".qwen/settings.jsonc"),
            new Source("kimi-codex", "Kimi Codex", false, new[] { ".kimi-code", ".kimi" }, ".kimi-code/config.toml", ".kimi/config.toml")
        };
    }

    public static class Data
    {
        public static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 262144, RecursionLimit = 32 }; }
        public static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        public static object Get(object value, string key) { object result; return Map(value).TryGetValue(key, out result) ? result : null; }
        public static string Text(object value) { return value as string ?? ""; }
        public static double Number(object value)
        {
            if (!(value is int || value is long || value is decimal || value is double || value is float)) return 0;
            double result = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            return double.IsNaN(result) || double.IsInfinity(result) ? 0 : Math.Max(0, Math.Min(1e15, result));
        }
        public static string Label(object value)
        {
            string text = Text(value);
            return text.Length <= 100 && Regex.IsMatch(text, @"^[\w.\- /:]+$") && !text.Contains("sk-") ? text : "未知";
        }
        public static string Hash(string value)
        { using (var hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(value))); }
        public static DateTime? Date(object value)
        {
            DateTime result;
            return DateTime.TryParse(Text(value), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out result) ? result : (DateTime?)null;
        }
        public static bool SafePath(string path)
        {
            try
            {
                string full = Path.GetFullPath(path);
                if (full.StartsWith(@"\\", StringComparison.Ordinal) || new DriveInfo(Path.GetPathRoot(full)).DriveType == DriveType.Network) return false;
                string root = Path.GetPathRoot(full), current = root;
                foreach (string part in full.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
                {
                    current = Path.Combine(current, part);
                    try { if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false; }
                    catch (FileNotFoundException) { return true; }
                    catch (DirectoryNotFoundException) { return true; }
                }
                return true;
            }
            catch { return false; }
        }
        public static string SmallFile(string path)
        {
            if (!SafePath(path) || !File.Exists(path)) return null;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (stream.Length > 262144) return null;
                var bytes = new byte[262145]; int length = 0, read;
                while (length < bytes.Length && (read = stream.Read(bytes, length, bytes.Length - length)) > 0) length += read;
                return length > 262144 ? null : Encoding.UTF8.GetString(bytes, 0, length).TrimStart('\uFEFF');
            }
        }
        public static void Save(string path, object value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, Json().Serialize(value), new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    public sealed class Settings
    {
        public List<string> Enabled = Source.All.Select(source => source.Id).ToList();
        public string Selected = "codex";
        public int Interval = 60;
        public bool Paused, Pinned;
        public static Settings Load(string path)
        {
            if (!File.Exists(path)) return new Settings();
            string content = Data.SmallFile(path);
            if (content == null) throw new InvalidDataException("设置不可读，原文件保留");
            var value = Data.Json().Deserialize<Settings>(content);
            if (value == null || value.Enabled == null || value.Enabled.Any(id => !Source.All.Any(source => source.Id == id)) ||
                !new[] { 30, 60, 120, 300 }.Contains(value.Interval) || !Source.All.Any(source => source.Id == value.Selected))
                throw new InvalidDataException("设置格式无效，原文件保留");
            value.Enabled = value.Enabled.Distinct().ToList(); return value;
        }
        public Settings Copy() { return Data.Json().Deserialize<Settings>(Data.Json().Serialize(this)); }
    }

    public sealed class Tokens
    {
        public double Input, Read, Write, Output;
        public double Total { get { return Input + Read + Write + Output; } }
        public static Tokens Parse(object value, bool codex)
        {
            double input = Data.Number(Data.Get(value, "input_tokens"));
            double read = Data.Number(Data.Get(value, codex ? "cached_input_tokens" : "cache_read_input_tokens"));
            double write = Data.Number(Data.Get(value, codex ? "cache_write_input_tokens" : "cache_creation_input_tokens"));
            if (codex) { read = Math.Min(read, input); write = Math.Min(write, input - read); input -= read + write; }
            return new Tokens { Input = input, Read = read, Write = write, Output = Data.Number(Data.Get(value, "output_tokens")) };
        }
        public Tokens Delta(Tokens before) { return new Tokens { Input = Math.Max(0, Input - before.Input), Read = Math.Max(0, Read - before.Read), Write = Math.Max(0, Write - before.Write), Output = Math.Max(0, Output - before.Output) }; }
        public void Merge(Tokens other) { Input = Math.Max(Input, other.Input); Read = Math.Max(Read, other.Read); Write = Math.Max(Write, other.Write); Output = Math.Max(Output, other.Output); }
    }
    public sealed class Record
    {
        public string Id, Model, Provider;
        public DateTime At;
        public Tokens Tokens;
        public bool UnsupportedPrice;
        public Record Copy() { return new Record { Id = Id, Model = Model, Provider = Provider, At = At, UnsupportedPrice = UnsupportedPrice, Tokens = new Tokens { Input = Tokens.Input, Read = Tokens.Read, Write = Tokens.Write, Output = Tokens.Output } }; }
    }
    public sealed class Parser
    {
        public readonly Dictionary<string, Record> Records = new Dictionary<string, Record>();
        public int Problems;
        private readonly string source;
        private string session, model = "未知", provider = "";
        private Tokens cumulative = new Tokens();
        private bool hasTotal;
        public Parser(string source, string identity) { this.source = source; session = Data.Hash(identity); }
        public void Consume(string line, DateTime now)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            try
            {
                object row = Data.Json().DeserializeObject(line);
                if (!(row is Dictionary<string, object>)) { Problems++; return; }
                string type = Data.Text(Data.Get(row, "type"));
                object payload = Data.Get(row, "payload");
                if (source == "codex" && type == "session_meta")
                {
                    string identity = Data.Text(Data.Get(payload, "id"));
                    if (identity.Length > 0) session = Data.Hash(identity);
                    provider = Data.Label(Data.Get(payload, "model_provider")); return;
                }
                if (source == "codex" && type == "turn_context") { model = Data.Label(Data.Get(payload, "model")); return; }
                DateTime? at = Data.Date(Data.Get(row, "timestamp"));
                if (!at.HasValue || at.Value > now.AddMinutes(5)) return;
                Record record;
                if (source == "claude")
                {
                    if (type != "assistant") return;
                    object message = Data.Get(row, "message"), usage = Data.Get(message, "usage");
                    string identity = Data.Text(Data.Get(message, "id"));
                    if (identity.Length == 0) identity = Data.Text(Data.Get(row, "requestId"));
                    if (identity.Length == 0) identity = Data.Text(Data.Get(row, "uuid"));
                    if (identity.Length == 0 || Data.Get(row, "isApiErrorMessage") as bool? == true) return;
                    string sessionId = Data.Text(Data.Get(row, "sessionId"));
                    record = new Record { Id = Data.Hash((sessionId.Length > 0 ? Data.Hash(sessionId) : session) + "/" + identity), Model = Data.Label(Data.Get(message, "model")), Provider = "anthropic", At = at.Value, Tokens = Tokens.Parse(usage, false), UnsupportedPrice = Data.Number(Data.Get(Data.Get(usage, "cache_creation"), "ephemeral_1h_input_tokens")) > 0 };
                }
                else if (source == "codex")
                {
                    if (type != "event_msg" || Data.Text(Data.Get(payload, "type")) != "token_count") return;
                    object info = Data.Get(payload, "info"), total = Data.Get(info, "total_token_usage");
                    if (total == null) return;
                    var current = Tokens.Parse(total, true); var delta = current.Delta(cumulative);
                    if (hasTotal && current.Total < cumulative.Total) { Problems++; return; }
                    if (hasTotal && Math.Abs(delta.Total - (current.Total - cumulative.Total)) > 0.001) { Problems++; cumulative = current; return; }
                    object last = Data.Get(info, "last_token_usage");
                    if (!hasTotal && last != null && current.Total > Tokens.Parse(last, true).Total) { delta = Tokens.Parse(last, true); Problems++; }
                    hasTotal = true; cumulative = current;
                    record = new Record { Id = Data.Hash(session + "/" + at.Value.Ticks + "/" + current.Total.ToString(CultureInfo.InvariantCulture)), At = at.Value, Model = model, Provider = provider, Tokens = delta };
                }
                else return;
                if (record.At < now.AddDays(-35) || record.Tokens.Total <= 0) return;
                Record before;
                if (Records.TryGetValue(record.Id, out before)) { before.Tokens.Merge(record.Tokens); before.UnsupportedPrice |= record.UnsupportedPrice; }
                else Records.Add(record.Id, record);
                if (Records.Count > 2500) { Records.Remove(Records.OrderBy(pair => pair.Value.At).First().Key); Problems++; }
            }
            catch (Exception error) when (error is ArgumentException || error is InvalidOperationException || error is FormatException || error is OverflowException) { Problems++; }
        }
    }

    public sealed class FileState
    {
        public readonly string Path, Source;
        public Parser Parser;
        public long Offset, Length;
        public DateTime Stamp;
        private byte[] prefix = new byte[0];
        private byte[] boundary = new byte[0];
        private readonly MemoryStream pending = new MemoryStream();
        private bool skipping;
        public FileState(string path, string source) { Path = path; Source = source; Parser = new Parser(source, path); }
        public int Read(DateTime now, int budget, CancellationToken cancellation)
        {
            if (!Data.SafePath(Path)) return 0;
            var metadata = new FileInfo(Path);
            using (var stream = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var head = new byte[Math.Min(128, stream.Length)];
                int headRead = stream.Read(head, 0, head.Length);
                bool changed = prefix.Length > headRead || !prefix.SequenceEqual(head.Take(prefix.Length));
                if (Offset >= boundary.Length && stream.Length >= Offset && boundary.Length > 0)
                {
                    stream.Position = Offset - boundary.Length;
                    var previousBoundary = new byte[boundary.Length];
                    int boundaryRead = stream.Read(previousBoundary, 0, previousBoundary.Length);
                    changed |= boundaryRead != boundary.Length || !boundary.SequenceEqual(previousBoundary);
                }
                if (stream.Length < Offset || (stream.Length == Length && metadata.LastWriteTimeUtc != Stamp) || changed)
                { Offset = 0; pending.SetLength(0); skipping = false; Parser = new Parser(Source, Path); }
                prefix = head.Take(headRead).ToArray(); Length = stream.Length; Stamp = metadata.LastWriteTimeUtc;
                stream.Position = Offset;
                var buffer = new byte[8192]; int consumed = 0, count;
                while (consumed < budget && (count = stream.Read(buffer, 0, Math.Min(buffer.Length, budget - consumed))) > 0)
                {
                    cancellation.ThrowIfCancellationRequested();
                    for (int index = 0; index < count; index++)
                    {
                        if (buffer[index] == 10)
                        {
                            if (!skipping) Parser.Consume(Encoding.UTF8.GetString(pending.GetBuffer(), 0, (int)pending.Length), now);
                            pending.SetLength(0); skipping = false;
                        }
                        else if (!skipping)
                        {
                            if (pending.Length < 262144) pending.WriteByte(buffer[index]);
                            else { pending.SetLength(0); skipping = true; Parser.Problems++; }
                        }
                    }
                    consumed += count; Offset += count;
                }
                boundary = new byte[Math.Min(128, Offset)];
                stream.Position = Offset - boundary.Length;
                int captured = stream.Read(boundary, 0, boundary.Length);
                if (captured != boundary.Length) boundary = new byte[0];
                return consumed;
            }
        }
    }

    public sealed class Snapshot
    {
        public string Source, Channel = "未发现本地配置", Status = "", Official = "";
        public double TodayTokens, WeekTokens, MonthTokens;
        public int TodayRecords, Files, Unpriced;
        public double? TodayCost;
        public Dictionary<string, double> Models = new Dictionary<string, double>();
        public List<string> Audit = new List<string>();
        public bool Enabled;
        public DateTime ScannedAt;
    }

    public static class LocalAudit
    {
        private static readonly Dictionary<string, string[]> Hosts = new Dictionary<string, string[]> {
            { "codex", new[] { "api.openai.com", "chatgpt.com" } }, { "claude", new[] { "api.anthropic.com" } },
            { "dsh-deepseek", new[] { "api.deepseek.com" } }, { "qwen-codex", new[] { "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com" } },
            { "kimi-codex", new[] { "api.moonshot.cn", "api.moonshot.ai", "api.kimi.com" } }
        };
        public static string Origin(string endpoint)
        {
            Uri uri;
            return Uri.TryCreate(endpoint, UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http") ? uri.GetLeftPart(UriPartial.Authority).Replace(uri.UserInfo + "@", "") : null;
        }
        public static void Read(string home, Source source, Snapshot result)
        {
            bool configured = false; var endpoints = new HashSet<string>();
            foreach (string config in source.Configs)
            {
                string content;
                try { content = Data.SmallFile(System.IO.Path.Combine(home, config)); } catch { result.Audit.Add("部分配置无法读取"); continue; }
                if (content == null) continue;
                configured = true;
                foreach (Match match in Regex.Matches(content, "(?:base_url|baseUrl|ANTHROPIC_BASE_URL|OPENAI_BASE_URL|api_base)[\\\"']?\\s*[:=]\\s*[\\\"']?(https?://[^\\s\\\"'<>]+)", RegexOptions.IgnoreCase))
                {
                    string origin = Origin(match.Groups[1].Value);
                    if (origin != null) endpoints.Add(origin);
                }
                foreach (string key in new[] { "logPrompts", "usageStatisticsEnabled", "enable_telemetry", "telemetryEnabled" })
                {
                    var match = Regex.Match(content, "[\\\"']?" + key + "[\\\"']?\\s*[:=]\\s*(true|false)\\b", RegexOptions.IgnoreCase);
                    if (match.Success) result.Audit.Add(key + " = " + match.Groups[1].Value.ToLowerInvariant() + "（配置声明）");
                }
            }
            foreach (string endpoint in endpoints) result.Audit.Add("配置端点：" + endpoint);
            string[] hosts; bool known = Hosts.TryGetValue(source.Id, out hosts);
            bool official = endpoints.Count == 1 && known && hosts.Contains(new Uri(endpoints.First()).Host);
            result.Channel = endpoints.Count > 1 ? "多个端点，当前渠道未知" : official ? "官方 API 配置" : endpoints.Count == 1 ? "自定义端点（可能为中转）" : configured || result.Files > 0 ? "渠道未知" : "未发现本地配置";
            var root = source.Roots[0].Split('/')[0];
            string local = System.IO.Path.Combine(home, root, source.Id == "dsh-deepseek" ? "balance.json" : "subscription.json");
            try
            {
                string content = Data.SmallFile(local);
                var value = content == null ? null : Data.Json().DeserializeObject(content);
                bool subscription = official && Data.Text(Data.Get(value, "auth_mode")) == "subscription";
                if (subscription) result.Channel = "官方订阅（本地声明）";
                var fields = new List<string>();
                if (source.Id == "dsh-deepseek" && Data.Get(value, "balance") is ValueType && !(Data.Get(value, "balance") is bool))
                {
                    double balance = Convert.ToDouble(Data.Get(value, "balance"), CultureInfo.InvariantCulture);
                    if (!double.IsNaN(balance) && !double.IsInfinity(balance) && Math.Abs(balance) <= 1e12)
                        fields.Add("本地余额：" + balance.ToString("0.##", CultureInfo.InvariantCulture) + "（币种以客户端为准）");
                }
                if (subscription)
                {
                    DateTime? expiry = Data.Date(Data.Get(value, "planExpiry"));
                    if (expiry.HasValue) fields.Add("套餐到期：" + expiry.Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm"));
                    var windows = Data.Get(value, "quotaWindows") as IEnumerable;
                    if (windows != null) foreach (object window in windows)
                    {
                        string name = Data.Text(Data.Get(window, "name")); object used = Data.Get(window, "usedPercent");
                        if ((name == "5h" || name == "7d") && (used is int || used is decimal || used is double))
                        {
                            double percent = Convert.ToDouble(used, CultureInfo.InvariantCulture);
                            if (!double.IsNaN(percent) && !double.IsInfinity(percent) && percent >= 0 && percent <= 100)
                                fields.Add((name == "5h" ? "5 小时" : "7 天") + "已用：" + percent.ToString("0.#") + "%");
                        }
                    }
                }
                if (fields.Count > 0) result.Official = string.Join("\r\n", fields) + "\r\n本地缓存，不保证实时；文件更新 " + File.GetLastWriteTime(local).ToString("yyyy-MM-dd HH:mm");
            }
            catch { result.Audit.Add("本地余额或订阅缓存不可读，已隐藏"); }
            result.Audit.Add("仅检查本地配置；无法据此判断客户端是否实际上传数据。");
        }
    }

    public sealed class Pricing
    {
        public List<Dictionary<string, object>> Rules = new List<Dictionary<string, object>>();
        public static Pricing Load(string path)
        {
            var result = new Pricing(); if (!File.Exists(path)) return result;
            var root = Data.Json().DeserializeObject(Data.SmallFile(path) ?? "null");
            var rules = Data.Get(root, "rules") as IEnumerable;
            if (rules == null) throw new InvalidDataException("价格规则损坏");
            foreach (object item in rules) result.Rules.Add(Data.Map(item));
            return result;
        }
        public double? Cost(string source, Record record)
        {
            if (record.UnsupportedPrice) return null;
            var rule = Rules.Where(item => Data.Text(Data.Get(item, "source")) == source && Data.Text(Data.Get(item, "model")) == record.Model &&
                (Data.Text(Data.Get(item, "provider")) == "" || Data.Text(Data.Get(item, "provider")) == record.Provider))
                .OrderByDescending(item => Data.Text(Data.Get(item, "provider")).Length).FirstOrDefault();
            if (rule == null) return null;
            object prices = Data.Get(rule, "prices"); double sum = 0;
            var amounts = new[] { record.Tokens.Input, record.Tokens.Output, record.Tokens.Read, record.Tokens.Write };
            var names = new[] { "input", "output", "cache_read", "cache_write" };
            for (int index = 0; index < names.Length; index++)
            {
                if (amounts[index] == 0) continue;
                object raw = Data.Get(prices, names[index]);
                if (!(raw is int || raw is decimal || raw is double)) return null;
                double price = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                if (double.IsNaN(price) || double.IsInfinity(price) || price < 0 || price > 1e6) return null;
                sum += amounts[index] * price / 1e6;
            }
            return sum;
        }
    }

    public sealed class Monitor
    {
        private readonly string home, pricingPath;
        private readonly bool allowEnvironment;
        private readonly Dictionary<string, FileState> states = new Dictionary<string, FileState>(StringComparer.OrdinalIgnoreCase);
        private int cursor;
        private bool recordsTrimmed;
        public long LastBytes;
        public Monitor(string home, string pricingPath, bool allowEnvironment = true) { this.home = home; this.pricingPath = pricingPath; this.allowEnvironment = allowEnvironment; }
        private IEnumerable<string> Roots(Source source)
        {
            foreach (string root in source.Roots) yield return System.IO.Path.Combine(home, root);
            string external = allowEnvironment ? Environment.GetEnvironmentVariable(source.Id == "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR") : null;
            if (!string.IsNullOrWhiteSpace(external) && System.IO.Path.IsPathRooted(external))
            {
                if (source.Id == "codex") { yield return System.IO.Path.Combine(external, "sessions"); yield return System.IO.Path.Combine(external, "archived_sessions"); }
                else if (source.Id == "claude") yield return System.IO.Path.Combine(external, "projects");
            }
        }
        public List<Snapshot> Scan(Settings settings, CancellationToken cancellation)
        {
            DateTime now = DateTime.UtcNow;
            var snapshots = Source.All.Select(source => new Snapshot { Source = source.Id, Enabled = settings.Enabled.Contains(source.Id), ScannedAt = now }).ToList();
            var candidates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int visited = 0; bool bounded = recordsTrimmed; LastBytes = 0;
            foreach (var source in Source.All.Where(source => settings.Enabled.Contains(source.Id) && source.Usage))
            {
                var stack = new Stack<string>(Roots(source).Distinct(StringComparer.OrdinalIgnoreCase));
                while (stack.Count > 0 && visited < 5000 && candidates.Count < 256)
                {
                    cancellation.ThrowIfCancellationRequested(); string directory = stack.Pop();
                    if (!Data.SafePath(directory) || !Directory.Exists(directory)) continue;
                    try
                    {
                        foreach (string path in Directory.EnumerateFileSystemEntries(directory))
                        {
                            cancellation.ThrowIfCancellationRequested();
                            if (++visited > 5000 || candidates.Count >= 256) { bounded = true; break; }
                            if (!Data.SafePath(path)) continue;
                            if (Directory.Exists(path)) stack.Push(path);
                            else if (path.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase) && File.GetLastWriteTimeUtc(path) >= now.AddDays(-35)) candidates[path] = source.Id;
                        }
                    }
                    catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { bounded = true; }
                }
                if (stack.Count > 0) bounded = true;
            }
            foreach (string removed in states.Keys.Where(path => !candidates.ContainsKey(path)).ToArray()) states.Remove(removed);
            var paths = candidates.Keys.OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToArray();
            int processed = 0;
            for (; processed < Math.Min(paths.Length, 400) && LastBytes < 8 * 1024 * 1024; processed++)
            {
                string path = paths[(cursor + processed) % paths.Length]; FileState state;
                if (!states.TryGetValue(path, out state)) states[path] = state = new FileState(path, candidates[path]);
                try { LastBytes += state.Read(now, Math.Min(2 * 1024 * 1024, (int)(8 * 1024 * 1024 - LastBytes)), cancellation); }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { bounded = true; }
            }
            if (paths.Length > 0) cursor = (cursor + processed) % paths.Length;
            int recordCount = states.Values.Sum(state => state.Parser.Records.Count);
            foreach (var state in states.Values)
            {
                foreach (string expired in state.Parser.Records.Where(pair => pair.Value.At < now.AddDays(-35)).Select(pair => pair.Key).ToArray()) { state.Parser.Records.Remove(expired); recordCount--; }
                if (recordCount > 20000)
                {
                    foreach (string key in state.Parser.Records.OrderBy(pair => pair.Value.At).Take(recordCount - 20000).Select(pair => pair.Key).ToArray()) { state.Parser.Records.Remove(key); recordCount--; }
                    bounded = true; recordsTrimmed = true;
                }
            }
            Pricing pricing;
            bool badPricing = false;
            try { pricing = Pricing.Load(pricingPath); } catch { pricing = new Pricing(); badPricing = true; }
            foreach (var snapshot in snapshots)
            {
                var source = Source.All.First(item => item.Id == snapshot.Source);
                if (!snapshot.Enabled) { snapshot.Status = "已停用；不读取此来源"; continue; }
                var selected = states.Values.Where(state => state.Source == source.Id).ToList(); snapshot.Files = selected.Count;
                var records = new Dictionary<string, Record>();
                foreach (var record in selected.SelectMany(state => state.Parser.Records.Values))
                {
                    Record previous;
                    if (records.TryGetValue(record.Id, out previous)) { previous.Tokens.Merge(record.Tokens); previous.UnsupportedPrice |= record.UnsupportedPrice; }
                    else records[record.Id] = record.Copy();
                }
                foreach (var record in records.Values)
                {
                    if (record.At.ToLocalTime() >= new DateTime(now.ToLocalTime().Year, now.ToLocalTime().Month, 1)) snapshot.MonthTokens += record.Tokens.Total;
                    if (record.At >= now.AddDays(-7)) { snapshot.WeekTokens += record.Tokens.Total; if (!snapshot.Models.ContainsKey(record.Model)) snapshot.Models[record.Model] = 0; snapshot.Models[record.Model] += record.Tokens.Total; }
                    if (record.At.ToLocalTime().Date == now.ToLocalTime().Date)
                    {
                        snapshot.TodayTokens += record.Tokens.Total; snapshot.TodayRecords++;
                        double? cost = pricing.Cost(source.Id, record); if (cost.HasValue) snapshot.TodayCost = (snapshot.TodayCost ?? 0) + cost.Value; else snapshot.Unpriced++;
                    }
                }
                bool incomplete = bounded || selected.Any(state => state.Offset < state.Length || state.Parser.Problems > 0);
                snapshot.Status = !source.Usage ? "计量协议未验证，仅展示本地配置证据" : incomplete ? "扫描受限或日志不连续；当前为部分统计" : snapshot.Files == 0 ? "未发现用量日志；请先使用对应客户端" : "本地增量统计";
                if (badPricing) snapshot.Status += "；价格文件不可读，费用隐藏";
                LocalAudit.Read(home, source, snapshot);
            }
            return snapshots;
        }
    }
}
