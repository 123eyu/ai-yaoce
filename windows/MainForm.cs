using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AiYaoce
{
    public sealed class MainForm : Form
    {
        private readonly Settings settings;
        private readonly string settingsPath, pricingPath;
        private readonly Monitor monitor;
        private readonly NotifyIcon tray;
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly CheckedListBox sources = new CheckedListBox();
        private readonly Label channel = new Label(), status = new Label(), official = new Label();
        private readonly Label[] metrics = new Label[4];
        private readonly DataGridView models = new DataGridView();
        private readonly ListBox audit = new ListBox();
        private readonly Button refresh = new Button(), prices = new Button();
        private readonly CheckBox pause = new CheckBox(), pin = new CheckBox();
        private readonly ComboBox interval = new ComboBox();
        private bool ready, closing, rerun, resourcesReleased;
        private int generation;
        private List<Snapshot> snapshots = new List<Snapshot>();
        private Image logo;
        public bool Busy { get; private set; }
        public int RefreshCount { get; private set; }
        public long LastBytes { get { return monitor.LastBytes; } }
        public bool TrayVisible { get { return tray.Visible; } }
        public string SelectedSource { get { return settings.Selected; } }
        public List<Snapshot> Snapshots { get { return snapshots; } }

        public MainForm(string home, string dataDirectory, bool testing)
        {
            settingsPath = Path.Combine(dataDirectory, "native-settings.json");
            pricingPath = Path.Combine(dataDirectory, "pricing-rules.json");
            settings = Settings.Load(settingsPath);
            monitor = new Monitor(home, pricingPath, !testing);
            Text = "AI 遥测"; Name = "AiYaoceMain";
            Font = new Font("Segoe UI", 10); BackColor = Color.White; ForeColor = Color.FromArgb(36, 48, 68);
            AutoScaleMode = AutoScaleMode.Dpi; MinimumSize = new Size(760, 600); Size = new Size(900, 700);
            StartPosition = FormStartPosition.CenterScreen; TopMost = settings.Pinned;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(16) };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 56)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            Controls.Add(root);
            var heading = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"))
            using (var original = Image.FromStream(resource)) logo = new Bitmap(original);
            heading.Controls.Add(new PictureBox { Image = logo, SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(38, 38), Margin = new Padding(0, 0, 12, 0) });
            heading.Controls.Add(new Label { Text = "AI 遥测", AutoSize = true, Font = new Font(Font.FontFamily, 19, FontStyle.Bold), Margin = new Padding(0, 0, 16, 0) });
            heading.Controls.Add(new Label { Text = "轻量版 2.0.0  /  仅在本机读取", AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(0, 12, 0, 0) });
            root.Controls.Add(heading, 0, 0);
            var content = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 162)); content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            root.Controls.Add(content, 0, 1);
            sources.Dock = DockStyle.Fill; sources.BorderStyle = BorderStyle.None; sources.CheckOnClick = false; sources.IntegralHeight = false;
            sources.AccessibleName = "来源与监控启停";
            foreach (Source source in Source.All) sources.Items.Add(source.Name, settings.Enabled.Contains(source.Id));
            content.Controls.Add(sources, 0, 0);
            var details = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(12, 0, 0, 0) };
            details.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); details.RowStyles.Add(new RowStyle(SizeType.Absolute, 90));
            details.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); details.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            details.RowStyles.Add(new RowStyle(SizeType.Absolute, 115)); details.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            content.Controls.Add(details, 1, 0);
            channel.Dock = DockStyle.Fill; channel.Font = new Font(Font, FontStyle.Bold); channel.Text = "等待读取本地数据"; details.Controls.Add(channel, 0, 0);
            var counters = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1, BackColor = Color.FromArgb(243, 245, 247), Margin = new Padding(0, 0, 0, 12) };
            counters.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            string[] names = { "今日 token", "近 7 天 token", "今日计量记录", "今日参考费用" };
            for (int index = 0; index < 4; index++)
            {
                counters.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
                var box = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8) };
                box.Controls.Add(new Label { Text = names[index], Dock = DockStyle.Top, Height = 22, Font = new Font(Font.FontFamily, 9) });
                metrics[index] = new Label { Text = "—", Dock = DockStyle.Bottom, Height = 34, Font = new Font(Font.FontFamily, 18, FontStyle.Bold), ForeColor = Color.FromArgb(23, 107, 214), AccessibleName = names[index] };
                box.Controls.Add(metrics[index]); counters.Controls.Add(box, index, 0);
            }
            details.Controls.Add(counters, 0, 1);
            ConfigureGrid(models); models.ReadOnly = true; models.Columns.Add("model", "模型（近 7 天）"); models.Columns.Add("tokens", "Token");
            models.Columns[0].FillWeight = 70; models.Columns[1].FillWeight = 30; details.Controls.Add(models, 0, 2);
            official.AutoSize = true; official.Dock = DockStyle.Top; official.Padding = new Padding(0, 8, 0, 8); official.MaximumSize = new Size(600, 0); official.Visible = false; details.Controls.Add(official, 0, 3);
            audit.Dock = DockStyle.Fill; audit.IntegralHeight = false; audit.BorderStyle = BorderStyle.FixedSingle; audit.HorizontalScrollbar = true; audit.AccessibleName = "本地隐私审计"; audit.Font = new Font(Font.FontFamily, 9); details.Controls.Add(audit, 0, 4);
            status.Dock = DockStyle.Fill; status.Font = new Font(Font.FontFamily, 9); status.Text = "未读取的数据不显示为零"; details.Controls.Add(status, 0, 5);
            var controls = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 6, 0, 0) };
            refresh.Text = "刷新"; refresh.AutoSize = true; refresh.Click += async (sender, args) => await RefreshAsync();
            pause.Text = "暂停读取"; pause.AutoSize = true; pause.Checked = settings.Paused;
            pin.Text = "窗口置顶"; pin.AutoSize = true; pin.Checked = settings.Pinned;
            interval.DropDownStyle = ComboBoxStyle.DropDownList; interval.Width = 100;
            interval.Items.AddRange(new object[] { "30 秒", "60 秒", "120 秒", "300 秒" }); interval.SelectedIndex = Array.IndexOf(new[] { 30, 60, 120, 300 }, settings.Interval);
            prices.Text = "参考价格"; prices.AutoSize = true; prices.Click += (sender, args) => { using (var dialog = new PriceForm(pricingPath)) { dialog.ShowDialog(this); } RequestRefresh(); };
            var quit = new Button { Text = "退出", AutoSize = true }; quit.Click += (sender, args) => ExitApp();
            controls.Controls.AddRange(new Control[] { refresh, pause, pin, interval, prices, quit }); root.Controls.Add(controls, 0, 2);
            sources.SelectedIndexChanged += (sender, args) => { if (sources.SelectedIndex < 0) return; settings.Selected = Source.All[sources.SelectedIndex].Id; if (ready) Persist(); Render(); };
            sources.ItemCheck += (sender, args) =>
            {
                if (!ready) return;
                string id = Source.All[args.Index].Id;
                if (args.NewValue == CheckState.Checked) { if (!settings.Enabled.Contains(id)) settings.Enabled.Add(id); }
                else settings.Enabled.Remove(id);
                generation++; Persist(); Render(); RequestRefresh();
            };
            pause.CheckedChanged += (sender, args) => { settings.Paused = pause.Checked; generation++; Persist(); Render(); if (!settings.Paused) RequestRefresh(); };
            pin.CheckedChanged += (sender, args) => { settings.Pinned = pin.Checked; TopMost = settings.Pinned; Persist(); };
            interval.SelectedIndexChanged += (sender, args) => { settings.Interval = new[] { 30, 60, 120, 300 }[interval.SelectedIndex]; timer.Interval = settings.Interval * 1000; Persist(); };
            tray = new NotifyIcon { Icon = Icon, Text = "AI 遥测 · 本地监控", Visible = true };
            var menu = new ContextMenuStrip();
            menu.Items.Add("显示窗口", null, (sender, args) => ShowWindow());
            menu.Items.Add("暂停 / 恢复读取", null, (sender, args) => pause.Checked = !pause.Checked);
            menu.Items.Add("退出", null, (sender, args) => ExitApp()); tray.ContextMenuStrip = menu;
            tray.DoubleClick += (sender, args) => ShowWindow();
            FormClosing += (sender, args) => { if (!closing && args.CloseReason == CloseReason.UserClosing) { args.Cancel = true; Hide(); } };
            timer.Interval = settings.Interval * 1000; timer.Tick += async (sender, args) => await RefreshAsync();
            sources.SelectedIndex = Array.FindIndex(Source.All, source => source.Id == settings.Selected);
            ready = true; Shown += async (sender, args) => { timer.Start(); await RefreshAsync(); };
        }
        public static void ConfigureGrid(DataGridView grid)
        {
            grid.Dock = DockStyle.Fill; grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            grid.AllowUserToAddRows = false; grid.AllowUserToDeleteRows = false; grid.AllowUserToResizeRows = false;
            grid.RowHeadersVisible = false; grid.BackgroundColor = Color.White; grid.BorderStyle = BorderStyle.None;
            grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect; grid.MultiSelect = false;
            grid.AutoGenerateColumns = false; grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
        }
        private void Persist()
        {
            if (!ready) return;
            try { Data.Save(settingsPath, settings); }
            catch { MessageBox.Show(this, "设置保存失败。本次设置仅在当前运行期间生效。", "AI 遥测", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }
        private void RequestRefresh() { if (IsHandleCreated && !closing) BeginInvoke(new Action(async () => await RefreshAsync())); }
        public async Task RefreshAsync()
        {
            if (closing || settings.Paused) return;
            if (Busy) { rerun = true; return; }
            Busy = true; refresh.Enabled = false; int current = generation;
            var selection = settings.Copy();
            try
            {
                var result = await Task.Run(() => monitor.Scan(selection, stop.Token));
                if (!closing && current == generation) { snapshots = result; RefreshCount++; Render(); }
            }
            catch (OperationCanceledException) { }
            catch { if (!closing) status.Text = "本地读取失败，保留上次统计；请检查目录访问权限"; }
            finally { Busy = false; if (!closing) refresh.Enabled = true; if (rerun && !closing) { rerun = false; RequestRefresh(); } }
        }
        public void SelectSource(string id) { sources.SelectedIndex = Array.FindIndex(Source.All, source => source.Id == id); }
        public void SetSourceEnabled(string id, bool enabled) { sources.SetItemChecked(Array.FindIndex(Source.All, source => source.Id == id), enabled); }
        public void SetPaused(bool value) { pause.Checked = value; }
        public bool MetricsFit() { return metrics.All(metric => metric.Parent.ClientRectangle.Contains(metric.Bounds) && metric.Parent.Parent.ClientRectangle.Contains(metric.Parent.Bounds)); }
        public void ShowWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }
        private static string Count(double value) { return value >= 1e6 ? (value / 1e6).ToString("0.##") + "M" : value >= 1000 ? (value / 1000).ToString("0.##") + "K" : value.ToString("0"); }
        private void Render()
        {
            var snapshot = snapshots.FirstOrDefault(item => item.Source == settings.Selected);
            bool enabled = settings.Enabled.Contains(settings.Selected);
            channel.Text = Source.All.First(source => source.Id == settings.Selected).Name + "  /  " + (!enabled ? "已停用" : snapshot == null ? "等待读取" : snapshot.Channel);
            for (int index = 0; index < metrics.Length; index++) metrics[index].Text = "—";
            models.Rows.Clear(); audit.Items.Clear(); official.Visible = false;
            if (!enabled || snapshot == null) { status.Text = enabled ? "请等待本地读取完成" : "已停用；勾选来源后恢复读取，不删除客户端文件"; return; }
            if (snapshot.Files > 0)
            {
                metrics[0].Text = Count(snapshot.TodayTokens); metrics[1].Text = Count(snapshot.WeekTokens);
                metrics[2].Text = snapshot.TodayRecords.ToString(); metrics[3].Text = snapshot.TodayCost.HasValue ? "≈$" + snapshot.TodayCost.Value.ToString("0.##") : "—";
            }
            foreach (var model in snapshot.Models.OrderByDescending(pair => pair.Value).Take(20)) models.Rows.Add(model.Key, Count(model.Value));
            official.Text = snapshot.Official; official.Visible = snapshot.Official.Length > 0;
            foreach (string item in snapshot.Audit) audit.Items.Add(item);
            if (snapshot.Unpriced > 0) audit.Items.Add(snapshot.Unpriced + " 条未计价；参考费用并非账单");
            audit.Items.Add("本月 token：" + Count(snapshot.MonthTokens));
            status.Text = (settings.Paused ? "已暂停 / " : "") + snapshot.Status + "\r\n" + snapshot.Files + " 个日志文件 · 更新 " + snapshot.ScannedAt.ToLocalTime().ToString("HH:mm:ss");
        }
        public void ExitApp() { closing = true; timer.Stop(); stop.Cancel(); tray.Visible = false; Close(); }
        protected override void Dispose(bool disposing)
        {
            if (disposing && !resourcesReleased)
            {
                resourcesReleased = true; closing = true; timer.Dispose(); stop.Cancel();
                if (tray != null) { tray.Visible = false; if (tray.ContextMenuStrip != null) tray.ContextMenuStrip.Dispose(); tray.Dispose(); }
                if (logo != null) logo.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class PriceForm : Form
    {
        private readonly DataGridView grid = new DataGridView();
        private readonly string path;
        public PriceForm(string path)
        {
            this.path = path; Text = "参考价格 · 美元 / 百万 token"; Size = new Size(850, 460); MinimumSize = new Size(750, 400);
            Font = new Font("Segoe UI", 10); StartPosition = FormStartPosition.CenterParent;
            MainForm.ConfigureGrid(grid); grid.AllowUserToAddRows = true; grid.AllowUserToDeleteRows = true; Controls.Add(grid);
            var sourceColumn = new DataGridViewComboBoxColumn { Name = "source", HeaderText = "来源", DataSource = Source.All.Select(source => source.Id).ToArray() }; grid.Columns.Add(sourceColumn);
            foreach (string name in new[] { "model", "provider", "input", "output", "cache_read", "cache_write" }) grid.Columns.Add(name, name);
            grid.DataError += (sender, args) => { args.ThrowException = false; };
            var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 65, AutoSize = true };
            bottom.Controls.Add(new Label { Text = "模型精确匹配；provider 留空匹配任意来源。价格留空=未知，0=免费。选行后按 Delete 删除。", AutoSize = true });
            var save = new Button { Text = "保存", AutoSize = true }; bottom.Controls.Add(save); Controls.Add(bottom);
            try
            {
                foreach (var rule in Pricing.Load(path).Rules)
                {
                    if (!Source.All.Any(source => source.Id == Data.Text(Data.Get(rule, "source")))) continue;
                    grid.Rows.Add(Data.Get(rule, "source"), Data.Get(rule, "model"), Data.Get(rule, "provider"), Data.Get(Data.Get(rule, "prices"), "input"), Data.Get(Data.Get(rule, "prices"), "output"), Data.Get(Data.Get(rule, "prices"), "cache_read"), Data.Get(Data.Get(rule, "prices"), "cache_write"));
                }
            }
            catch { save.Enabled = false; bottom.Controls.Add(new Label { Text = "价格文件不可读：禁止覆盖，请先备份修复", AutoSize = true }); }
            save.Click += (sender, args) => SaveRules();
        }
        private void SaveRules()
        {
            try
            {
                grid.EndEdit(); var rules = new List<object>(); var keys = new HashSet<string>();
                foreach (DataGridViewRow row in grid.Rows)
                {
                    if (row.IsNewRow) continue;
                    string source = Convert.ToString(row.Cells[0].Value), model = Convert.ToString(row.Cells[1].Value), provider = Convert.ToString(row.Cells[2].Value);
                    if (!Source.All.Any(item => item.Id == source) || string.IsNullOrWhiteSpace(model) || model.Length > 100 || provider.Length > 100) throw new InvalidDataException();
                    string key = Data.Json().Serialize(new[] { source, model, provider }); if (!keys.Add(key)) throw new InvalidDataException();
                    var rates = new Dictionary<string, double>();
                    for (int index = 3; index < 7; index++)
                    {
                        string text = Convert.ToString(row.Cells[index].Value); if (string.IsNullOrWhiteSpace(text)) continue;
                        double rate; if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out rate) || double.IsNaN(rate) || double.IsInfinity(rate) || rate < 0 || rate > 1e6) throw new InvalidDataException();
                        rates[grid.Columns[index].Name] = rate;
                    }
                    rules.Add(new { source, model, provider, alias = "", prices = rates });
                }
                Data.Save(path, new { rules }); DialogResult = DialogResult.OK; Close();
            }
            catch { MessageBox.Show(this, "无法保存：请检查来源、重复模型、数字单价和目录写入权限。原价格文件保留。", "AI 遥测"); }
        }
    }
}
