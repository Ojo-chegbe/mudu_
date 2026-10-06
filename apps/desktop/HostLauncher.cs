using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("MUDU Host")]
[assembly: System.Reflection.AssemblyVersion("0.1.3.0")]

internal sealed class HostWindow : Form {
    private Process host;
    private readonly Label status = new Label();
    private readonly Label detail = new Label();
    private readonly Button open = new Button();
    private readonly Panel startup = new Panel();
    private readonly Panel content = new Panel();
    private WorkspaceView workspace;
    private bool openingWorkspace;
    private readonly ToolStripMenuItem back = new ToolStripMenuItem("Back");
    private readonly ToolStripMenuItem forward = new ToolStripMenuItem("Forward");
    private readonly ToolStripMenuItem reload = new ToolStripMenuItem("Reload interface");
    private readonly Button retry = new Button();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly System.Windows.Forms.Timer startupTimer = new System.Windows.Forms.Timer();
    private bool quitting;
    private bool ready;
    private readonly string directory;
    private readonly string applicationRoot;
    private readonly Uri origin;
    private readonly Func<string, string> downloadSelector;
    internal WorkspaceView Workspace { get { return workspace; } }
    internal bool ServerReady { get { return ready; } }
    [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint flags);

    public HostWindow() : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MUDU", "Host"), 4310, AppDomain.CurrentDomain.BaseDirectory) { }
    internal HostWindow(string dataDirectory, int port, string root) : this(dataDirectory, port, root, null) { }
    internal HostWindow(string dataDirectory, int port, string root, Func<string, string> downloadSelector) {
        directory = dataDirectory;
        applicationRoot = root;
        origin = new Uri("http://127.0.0.1:" + port);
        this.downloadSelector = downloadSelector;
        Text = "MUDU Host";
        ClientSize = new Size(1280, 850);
        MinimumSize = new Size(900, 620);
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(250, 250, 250);
        Font = new Font("Segoe UI", 10);
        var title = new Label { Text = "MUDU Host", Location = new Point(28, 24), AutoSize = true, Font = new Font("Segoe UI", 20, FontStyle.Bold) };
        status.SetBounds(30, 84, 540, 30);
        detail.SetBounds(30, 120, 540, 84);
        detail.ForeColor = Color.FromArgb(90, 90, 90);
        open.Text = "Open in browser";
        open.SetBounds(30, 230, 155, 36);
        open.FlatStyle = FlatStyle.Flat;
        open.BackColor = Color.FromArgb(31, 89, 216);
        open.ForeColor = Color.White;
        open.Enabled = false;
        open.Visible = false;
        open.Click += delegate {
            try { Process.Start(new ProcessStartInfo(origin.AbsoluteUri) { UseShellExecute = true }); }
            catch { MessageBox.Show(this, "The browser could not open. Retry the app interface.", "MUDU Host"); }
        };
        retry.Text = "Retry";
        retry.SetBounds(200, 230, 170, 36);
        retry.FlatStyle = FlatStyle.Flat;
        retry.Visible = false;
        retry.Click += delegate { if (ready) OpenWorkspace(); else StartHost(); };
        startup.Size = new Size(600, 300);
        startup.Controls.AddRange(new Control[] {title, status, detail, open, retry});
        content.Dock = DockStyle.Fill;
        content.Controls.Add(startup);
        content.Resize += delegate { startup.Location = new Point(Math.Max(0, (content.Width - startup.Width) / 2), Math.Max(0, (content.Height - startup.Height) / 2)); };
        var menus = new MenuStrip();
        var file = new ToolStripMenuItem("Host");
        file.DropDownItems.Add("Workspace", null, delegate { if (workspace != null && ready) workspace.GoHome(); else OpenWorkspace(); });
        file.DropDownItems.Add("Close to tray", null, delegate { Close(); });
        file.DropDownItems.Add("Quit Host...", null, delegate { QuitHost(); });
        var view = new ToolStripMenuItem("View");
        back.ShortcutKeys = Keys.Alt | Keys.Left;
        forward.ShortcutKeys = Keys.Alt | Keys.Right;
        reload.ShortcutKeys = Keys.Control | Keys.R;
        back.Enabled = forward.Enabled = reload.Enabled = false;
        back.Click += delegate { if (workspace != null) workspace.GoBack(); };
        forward.Click += delegate { if (workspace != null) workspace.GoForward(); };
        reload.Click += delegate { if (workspace != null) workspace.ReloadWorkspace(); };
        view.DropDownItems.AddRange(new ToolStripItem[] { back, forward, reload });
        menus.Items.AddRange(new ToolStripItem[] { file, view });
        MainMenuStrip = menus;
        Controls.Add(content);
        Controls.Add(menus);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open MUDU", null, delegate { OpenWorkspace(); });
        menu.Items.Add("Show Host", null, delegate { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Quit Host…", null, delegate { QuitHost(); });
        tray.Text = "MUDU Host";
        tray.Icon = SystemIcons.Application;
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenWorkspace(); };
        startupTimer.Interval = 30000;
        startupTimer.Tick += delegate {
            startupTimer.Stop();
            if (!ready) {
                status.Text = "Starting is taking longer than expected";
                detail.Text = "Please wait. If it does not finish, quit the Host and open it again.";
            }
        };
        Shown += delegate { StartHost(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (!quitting && args.CloseReason == CloseReason.UserClosing) {
                args.Cancel = true;
                Hide();
                tray.ShowBalloonTip(2500, "MUDU Host is still running", "Use the tray icon to open MUDU or quit the Host.", ToolTipIcon.Info);
            } else if (!quitting) {
                RequestShutdown();
            }
        };
        FormClosed += delegate { SetThreadExecutionState(0x80000000); tray.Dispose(); startupTimer.Dispose(); if (workspace != null) workspace.Dispose(); if (host != null) host.Dispose(); };
    }

    private void StartHost() {
        if (HostRunning()) return;
        if (host != null) { host.Dispose(); host = null; }
        ready = false;
        ShowStartup();
        open.Enabled = false;
        open.Visible = false;
        retry.Text = "Retry";
        retry.Visible = false;
        status.Text = "Starting your Host…";
        detail.Text = "Your workspace will open when it is ready.";
        try {
            Directory.CreateDirectory(directory);
            var root = applicationRoot;
            var info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"));
            info.Arguments = "\"" + Path.Combine(root, "apps", "desktop", "launch.mjs") + "\" \"" + directory + "\" " + origin.Port;
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables.Remove("NODE_OPTIONS");
            info.EnvironmentVariables.Remove("NODE_PATH");
            host = new Process { StartInfo = info, EnableRaisingEvents = true };
            host.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) {
                if (args.Data == "MUDU_DESKTOP_READY") OnUI(delegate {
                    if (quitting || sender != host) return;
                    ready = true;
                    startupTimer.Stop();
                    status.Text = "Host running";
                    detail.Text = "Keep this computer on during examinations. Closing this window keeps the Host running.";
                    open.Enabled = true;
                    SetThreadExecutionState(0x80000001); // Prevent automatic sleep, not manual shutdown.
                    OpenWorkspace(Visible);
                });
            };
            // Drain stderr without showing credentials or internal paths to lecturers.
            host.ErrorDataReceived += delegate { };
            host.Exited += delegate(object sender, EventArgs args) { OnUI(delegate {
                if (sender != host) return;
                startupTimer.Stop();
                SetThreadExecutionState(0x80000000);
                if (quitting) return;
                ready = false;
                ShowStartup();
                open.Enabled = false;
                retry.Visible = true;
                status.Text = "Host could not stay running";
                detail.Text = "Close any other MUDU server, then retry. Your saved examination data has not been removed.";
                Show();
            }); };
            host.Start();
            host.BeginOutputReadLine();
            host.BeginErrorReadLine();
            startupTimer.Start();
        } catch {
            status.Text = "Host could not start";
            detail.Text = "Try reinstalling MUDU Host. Your examination data is stored separately and will be kept.";
            retry.Visible = true;
        }
    }

    private bool HostRunning() {
        try { return host != null && !host.HasExited; }
        catch (InvalidOperationException) { return false; }
    }

    private void OnUI(Action work) { if (!IsDisposed && IsHandleCreated) BeginInvoke(work); }
    private void ShowStartup() {
        startup.Visible = true;
        startup.BringToFront();
        if (workspace != null) workspace.Visible = false;
        back.Enabled = forward.Enabled = reload.Enabled = false;
    }
    private void OpenWorkspace() { OpenWorkspace(true); }
    private async void OpenWorkspace(bool showWindow) {
        if (showWindow) {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
        if (!ready || quitting || openingWorkspace) return;
        if (workspace != null && workspace.Visible) { workspace.Focus(); return; }
        openingWorkspace = true;
        open.Visible = false;
        retry.Visible = false;
        status.Text = "Opening your workspace...";
        detail.Text = "Your examination server is running.";
        try {
            if (workspace != null) { content.Controls.Remove(workspace); workspace.Dispose(); }
            workspace = new WorkspaceView(origin, Path.Combine(directory, "WebView2"), downloadSelector);
            var currentView = workspace;
            workspace.Visible = false;
            workspace.HistoryChanged += delegate { if (workspace != currentView || !ready || quitting) return; back.Enabled = workspace.CanGoBack; forward.Enabled = workspace.CanGoForward; };
            workspace.WorkspaceLoaded += delegate {
                if (!ready || quitting || workspace != currentView) return;
                startup.Visible = false;
                workspace.Visible = true;
                workspace.BringToFront();
                reload.Enabled = true;
            };
            workspace.Failed += delegate(string message) {
                if (!ready || quitting || workspace != currentView) return;
                ShowStartup();
                status.Text = "Reconnect your interface";
                detail.Text = message;
                retry.Text = "Retry interface";
                retry.Width = 170;
                retry.Visible = true;
                open.Enabled = true;
                open.Visible = true;
            };
            content.Controls.Add(workspace);
            await workspace.StartAsync();
        } catch {
            if (!ready || quitting) return;
            ShowStartup();
            status.Text = "The interface could not open";
            detail.Text = "Retry, or run the MUDU installer to repair its WebView2 runtime. The examination server is still running.";
            retry.Text = "Retry interface";
            retry.Width = 170;
            retry.Visible = true;
            open.Enabled = true;
            open.Visible = true;
        } finally { openingWorkspace = false; }
    }
    private async void QuitHost() {
        if (quitting) return;
        if (MessageBox.Show("Quitting disconnects candidates on this Host. Make sure examinations are finished before continuing. Saved answers will remain on this computer.", "Quit MUDU Host?", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        quitting = true;
        ShowStartup();
        detail.Text = "Please wait while the Host finishes its work.";
        open.Visible = retry.Visible = false;
        status.Text = "Stopping safely…";
        open.Enabled = false;
        bool stopped = await StopHostAsync();
        if (stopped) Close();
        else {
            quitting = false;
            if (workspace != null && workspace.Browser.CoreWebView2 != null) { startup.Visible = false; workspace.Visible = true; reload.Enabled = true; }
            MessageBox.Show("The Host is still finishing its work. Please wait and try quitting again.", "Host still running");
        }
    }
    private void RequestShutdown() {
        if (!HostRunning()) return;
        try {
            host.StandardInput.WriteLine("shutdown");
            host.StandardInput.Flush();
        } catch { }
    }
    private async Task<bool> StopHostAsync() {
        if (!HostRunning()) return true;
        var stoppingHost = host;
        RequestShutdown();
        // Keep the window responsive and never force-kill a live examination.
        bool stopped = await Task.Run(() => stoppingHost.WaitForExit(20000));
        if (stopped) SetThreadExecutionState(0x80000000);
        return stopped;
    }

    [STAThread] public static void Main() {
        // Do not let inherited developer overrides inject code or redirect the browser profile.
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
            var name = entry.Key.ToString();
            if (name.StartsWith("WEBVIEW2_", StringComparison.OrdinalIgnoreCase)) Environment.SetEnvironmentVariable(name, null);
        }
        bool first;
        using (var instance = new Mutex(true, "Local\\MUDUHostLauncher", out first)) {
            if (!first) { MessageBox.Show("MUDU Host is already running. Open it from the tray beside your clock.", "MUDU Host"); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HostWindow());
        }
    }
}
