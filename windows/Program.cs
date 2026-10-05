using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("AI 遥测")]
[assembly: AssemblyProduct("AI 遥测")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace AiYaoce
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] arguments)
        {
            bool smoke = arguments.Length == 3 && arguments[0] == "--smoke";
            bool performance = arguments.Length == 3 && arguments[0] == "--performance";
            bool testing = smoke || performance;
            string home = testing ? Path.GetFullPath(arguments[1]) : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string output = testing ? Path.GetFullPath(arguments[2]) : "";
            if (testing && !File.Exists(Path.Combine(home, ".ai-yaoce-test-home"))) return 2;
            if (arguments.Length > 0 && !testing) return 2;
            string data = testing ? Path.Combine(home, "app-settings") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ai-yaoce");
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            bool created;
            using (var mutex = new Mutex(true, "Local\\ai-yaoce-native-" + Data.Hash(data).Replace("/", "_").Replace("+", "-"), out created))
            {
                if (!created) return 0;
                try
                {
                    var started = Stopwatch.StartNew();
                    TimeSpan initialCpu = Process.GetCurrentProcess().TotalProcessorTime;
                    using (var form = new MainForm(home, data, testing))
                    {
                        if (smoke) form.Shown += async (sender, args) => await Smoke(form, home, output);
                        if (performance) form.Shown += async (sender, args) => await Performance(form, output, started, initialCpu);
                        Application.Run(form);
                    }
                    return Environment.ExitCode;
                }
                catch (Exception error)
                {
                    if (testing) { Directory.CreateDirectory(output); File.WriteAllText(Path.Combine(output, "failure.txt"), error.ToString()); }
                    else MessageBox.Show("无法启动：设置文件可能损坏或不可读。请备份 %APPDATA%\\ai-yaoce\\native-settings.json 后检查；程序没有覆盖该文件。", "AI 遥测", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        private static async Task Until(Func<bool> condition)
        {
            var clock = Stopwatch.StartNew();
            while (!condition()) { if (clock.Elapsed.TotalSeconds > 60) throw new Exception("等待超时"); await Task.Delay(50); }
        }
        private static async Task Smoke(MainForm form, string home, string output)
        {
            Directory.CreateDirectory(output); var checks = new System.Collections.Generic.List<string>();
            Action<bool, string> check = (result, name) => { if (!result) throw new Exception(name); checks.Add(name); };
            try
            {
                await Until(() => form.RefreshCount > 0 && !form.Busy);
                check(form.Visible && form.TrayVisible, "原生窗口与托盘创建");
                check(form.Snapshots.Count == 6, "六来源快照");
                check(form.Snapshots.First(item => item.Source == "codex").TodayTokens == 150, "读取隔离磁盘中的真实格式Codex日志");
                check(form.Snapshots.First(item => item.Source == "claude").TodayTokens == 17, "读取隔离磁盘中的真实格式Claude日志");
                foreach (var source in Source.All) { form.SelectSource(source.Id); check(form.SelectedSource == source.Id, "来源切换：" + source.Name); }
                form.SetSourceEnabled("claude", false); await Task.Delay(100); await Until(() => !form.Busy);
                await form.RefreshAsync(); check(!form.Snapshots.First(item => item.Source == "claude").Enabled, "停用后不读取来源");
                form.SetSourceEnabled("claude", true); await Task.Delay(100); await Until(() => !form.Busy);
                form.SetPaused(true); int before = form.RefreshCount; await form.RefreshAsync(); check(before == form.RefreshCount, "暂停阻止扫描");
                form.SetPaused(false); await Task.Delay(100); await Until(() => !form.Busy);
                await form.RefreshAsync(); check(form.LastBytes == 0, "日志不变时不重新读取正文");
                form.Hide(); check(!form.Visible && form.TrayVisible, "隐藏窗口后保留托盘"); form.ShowWindow();
                form.SelectSource("codex"); await Task.Delay(200);
                check(form.MetricsFit(), "指标数字完整落在可见区域");
                using (var image = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(image, new Rectangle(0, 0, form.Width, form.Height)); image.Save(Path.Combine(output, "native-window.png")); }
                File.WriteAllLines(Path.Combine(output, "layout.txt"), Layout(form));
                var saved = Settings.Load(Path.Combine(home, "app-settings", "native-settings.json"));
                check(saved.Selected == "codex" && saved.Enabled.Contains("claude") && !saved.Paused, "本地设置持久化");
                var process = Process.GetCurrentProcess(); process.Refresh();
                Data.Save(Path.Combine(output, "report.json"), new { passed = true, count = checks.Count, checks, platform = "win32", arch = "x64", version = "2.0.0", privateBytes = process.PrivateMemorySize64, workingSetBytes = process.WorkingSet64 });
            }
            catch (Exception error) { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(output, "failure.txt"), "原生验收失败：" + error.Message); }
            finally { form.ExitApp(); }
        }
        private static async Task Performance(MainForm form, string output, Stopwatch started, TimeSpan initialCpu)
        {
            Directory.CreateDirectory(output);
            try
            {
                await Until(() => form.RefreshCount > 0 && !form.Busy);
                int attempts = 0;
                do { await form.RefreshAsync(); if (++attempts > 30) throw new Exception("扫描未收敛"); } while (form.LastBytes > 0);
                var process = Process.GetCurrentProcess(); process.Refresh();
                double scanSeconds = started.Elapsed.TotalSeconds;
                double scanCpuSeconds = (process.TotalProcessorTime - initialCpu).TotalSeconds;
                double tokens = form.Snapshots.First(item => item.Source == "codex").TodayTokens;
                if (tokens != 12000) throw new Exception("负载统计不一致");
                form.Hide(); await Task.Delay(2000); process.Refresh();
                var idle = Stopwatch.StartNew(); TimeSpan idleCpu = process.TotalProcessorTime;
                long peakPrivate = process.PrivateMemorySize64, peakWorking = process.WorkingSet64;
                for (int sample = 0; sample < 30; sample++)
                {
                    await Task.Delay(500); process.Refresh();
                    peakPrivate = Math.Max(peakPrivate, process.PrivateMemorySize64); peakWorking = Math.Max(peakWorking, process.WorkingSet64);
                }
                double idleSeconds = idle.Elapsed.TotalSeconds;
                double idleCpuSeconds = (process.TotalProcessorTime - idleCpu).TotalSeconds;
                double idleCpuPercent = idleCpuSeconds / idleSeconds / Environment.ProcessorCount * 100;
                bool passed = peakPrivate < 100 * 1024 * 1024 && idleCpuPercent < 1;
                Data.Save(Path.Combine(output, "performance.json"), new { passed, scanSeconds, scanCpuSeconds, scanAverageCpuPercent = scanCpuSeconds / scanSeconds / Environment.ProcessorCount * 100, idleSeconds, idleCpuSeconds, idleCpuPercent, peakIdlePrivateBytes = peakPrivate, peakIdleWorkingSetBytes = peakWorking, peakWorkingSetBytes = process.PeakWorkingSet64, processorCount = Environment.ProcessorCount, tokens, fixture = "12 files, 12000 Codex usage events, metadata-only retained", scope = "Windows CI synthetic load; not a physical PC or real account benchmark" });
                if (!passed) Environment.ExitCode = 1;
            }
            catch (Exception error) { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(output, "failure.txt"), error.Message); }
            finally { form.ExitApp(); }
        }
        private static System.Collections.Generic.IEnumerable<string> Layout(Control control)
        {
            yield return control.GetType().Name + " " + control.Name + " text=" + control.Text + " bounds=" + control.Bounds + " client=" + control.ClientSize;
            foreach (Control child in control.Controls) foreach (string line in Layout(child)) yield return "  " + line;
        }
    }
}
