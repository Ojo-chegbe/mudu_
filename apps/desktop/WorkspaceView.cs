using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class WorkspaceView : UserControl {
    private readonly Uri origin;
    private readonly string profileDirectory;
    private readonly WebView2 browser = new WebView2();
    private CoreWebView2Environment environment;
    private bool disposed;
    private readonly Func<string, string> downloadSelector;
    public event EventHandler WorkspaceLoaded;
    public event EventHandler HistoryChanged;
    public event Action<string> Failed;
    internal WebView2 Browser { get { return browser; } }
    public bool CanGoBack { get { return browser.CoreWebView2 != null && browser.CoreWebView2.CanGoBack; } }
    public bool CanGoForward { get { return browser.CoreWebView2 != null && browser.CoreWebView2.CanGoForward; } }

    public WorkspaceView(Uri origin, string profileDirectory, Func<string, string> downloadSelector) {
        this.origin = origin;
        this.profileDirectory = profileDirectory;
        this.downloadSelector = downloadSelector;
        Dock = DockStyle.Fill;
        browser.Dock = DockStyle.Fill;
        browser.DefaultBackgroundColor = Color.FromArgb(250, 252, 255);
        Controls.Add(browser);
    }
    public async Task StartAsync() {
        Directory.CreateDirectory(profileDirectory);
        environment = await CoreWebView2Environment.CreateAsync(null, profileDirectory);
        if (disposed) return;
        await browser.EnsureCoreWebView2Async(environment);
        if (disposed) return;
        Configure(browser);
        browser.CoreWebView2.HistoryChanged += delegate {
            if (HistoryChanged != null) HistoryChanged(this, EventArgs.Empty);
        };
        browser.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) {
            if (disposed) return;
            if (!args.IsSuccess && args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) {
                Report("The interface could not load. Retry the interface; the examination server is still running.");
                return;
            }
            if (args.IsSuccess && WorkspaceLoaded != null) WorkspaceLoaded(this, EventArgs.Empty);
        };
        browser.CoreWebView2.ProcessFailed += delegate {
            if (!disposed) Report("The interface stopped responding. Retry the interface to reconnect to the running Host. Saved answers remain on the Host.");
        };
        browser.CoreWebView2.Navigate(origin.AbsoluteUri);
    }
    private void Configure(WebView2 view) {
        var core = view.CoreWebView2;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
            if (DesktopPolicy.IsWorkspace(args.Uri, origin)) return;
            args.Cancel = true;
            if (args.IsUserInitiated && !args.IsRedirected) OpenExternal(args.Uri);
        };
        core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
            if (!DesktopPolicy.IsWorkspace(args.Uri, origin)) args.Cancel = true;
        };
        core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) {
            args.State = CoreWebView2PermissionState.Deny;
        };
        core.WindowCloseRequested += delegate { var form = view.FindForm(); if (form != null) form.Close(); };
        core.NewWindowRequested += async delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) {
            args.Handled = true;
            if (!args.IsUserInitiated) return;
            if (!DesktopPolicy.IsWorkspace(args.Uri, origin)) { OpenExternal(args.Uri); return; }
            var deferral = args.GetDeferral();
            Form popup = null;
            try {
                popup = new Form { Text = "MUDU Host", ClientSize = new Size(1000, 760), MinimumSize = new Size(720, 540), StartPosition = FormStartPosition.CenterParent, AutoScaleMode = AutoScaleMode.Dpi };
                var popupView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = browser.DefaultBackgroundColor };
                popup.Controls.Add(popupView);
                popup.FormClosed += delegate { popupView.Dispose(); };
                var owner = FindForm();
                if (owner != null) popup.Opacity = owner.Opacity;
                popup.Show(owner);
                await popupView.EnsureCoreWebView2Async(environment);
                if (disposed || popup.IsDisposed) { if (!popup.IsDisposed) popup.Close(); return; }
                Configure(popupView);
                args.NewWindow = popupView.CoreWebView2;
            } catch {
                if (disposed || (popup != null && popup.IsDisposed)) return;
                if (popup != null && !popup.IsDisposed) popup.Close();
                MessageBox.Show(FindForm(), "This MUDU window could not open. Try again. The Host is still running.", "Could not open window");
            } finally { deferral.Complete(); }
        };
        core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) {
            args.Handled = true;
            if (!DesktopPolicy.IsDownload(args.DownloadOperation.Uri, origin)) { args.Cancel = true; return; }
            var deferral = args.GetDeferral();
            try {
                if (downloadSelector != null) {
                    var selected = downloadSelector(Path.GetFileName(args.ResultFilePath));
                    if (String.IsNullOrEmpty(selected)) args.Cancel = true;
                    else args.ResultFilePath = selected;
                    return;
                }
                using (var dialog = new SaveFileDialog()) {
                    dialog.Title = "Save MUDU download";
                    dialog.FileName = Path.GetFileName(args.ResultFilePath);
                    dialog.Filter = "All files (*.*)|*.*";
                    dialog.OverwritePrompt = true;
                    dialog.RestoreDirectory = true;
                    if (dialog.ShowDialog(view.FindForm()) != DialogResult.OK) args.Cancel = true;
                    else args.ResultFilePath = dialog.FileName;
                }
            } catch {
                args.Cancel = true;
                MessageBox.Show(view.FindForm(), "Choose another folder and try the download again.", "Download could not start");
            } finally { deferral.Complete(); }
        };
    }
    private void OpenExternal(string address) {
        if (!DesktopPolicy.IsExternal(address)) return;
        try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); }
        catch { MessageBox.Show(FindForm(), "The link could not open. Check your default browser and try again.", "Could not open link"); }
    }
    private void Report(string message) { if (!disposed && Failed != null) Failed(message); }
    public void GoBack() { if (CanGoBack) browser.CoreWebView2.GoBack(); }
    public void GoForward() { if (CanGoForward) browser.CoreWebView2.GoForward(); }
    public void ReloadWorkspace() { if (browser.CoreWebView2 != null) browser.CoreWebView2.Reload(); }
    public void GoHome() { if (browser.CoreWebView2 != null) browser.CoreWebView2.Navigate(origin.AbsoluteUri); }
    protected override void Dispose(bool disposing) {
        disposed = true;
        if (disposing) browser.Dispose();
        base.Dispose(disposing);
    }
}
