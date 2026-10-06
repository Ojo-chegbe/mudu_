using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

internal static class DesktopSmoke {
    private static int result = 1;
    private static async Task Wait(Func<Task<bool>> predicate, string message) {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 30000) {
            if (await predicate()) return;
            await Task.Delay(100);
        }
        throw new Exception(message);
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    [STAThread] public static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var directory = args[1];
        int port = Int32.Parse(args[2]);
        var origin = "http://127.0.0.1:" + port;
        var window = new HostWindow(directory, port, args[0], delegate(string filename) { return Path.Combine(directory, "smoke-export.csv"); });
        window.Opacity = 0;
        window.ShowInTaskbar = false;
        window.Shown += async delegate {
            try {
                await Wait(() => Task.FromResult(window.ServerReady && window.Workspace != null && window.Workspace.Browser.CoreWebView2 != null), "Desktop interface did not initialize");
                var core = window.Workspace.Browser.CoreWebView2;
                await Wait(async () => (await core.ExecuteScriptAsync("Boolean(document.querySelector('.auth-card'))")) == "true", "React interface did not render inside the app");
                Check(!core.Settings.AreHostObjectsAllowed && !core.Settings.IsWebMessageEnabled, "Page acquired native host privileges");
                Check(core.Environment.UserDataFolder.StartsWith(directory, StringComparison.OrdinalIgnoreCase), "Browser profile escaped isolated storage");
                Check(window.MinimumSize.Width >= 900 && window.MaximizeBox, "Host window must resize");
                Console.WriteLine("PASS actual WebView2 startup, React UI, profile isolation and native window");
                await core.ExecuteScriptAsync("localStorage.setItem('mudu-native-smoke', 'kept')");
                core.Navigate(origin + "/account/sign-in?mode=local");
                await Wait(async () => (await core.ExecuteScriptAsync("location.search.includes('mode=local') && Boolean(document.querySelector('.auth-card'))")) == "true", "Native navigation failed");
                window.Workspace.GoBack();
                await Wait(async () => (await core.ExecuteScriptAsync("location.search === ''")) == "true", "Native back navigation failed");
                Check((await core.ExecuteScriptAsync("localStorage.getItem('mudu-native-smoke')")) == "\"kept\"", "App profile was not retained during navigation");
                await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", "{\"expression\":\"window.open('/account/forgot-password?role=admin', '_blank')\",\"userGesture\":true}");
                await Wait(() => Task.FromResult(window.OwnedForms.Length == 1), "MUDU link did not open an in-app window");
                Check(window.OwnedForms[0].Text == "MUDU Host", "Unexpected popup shell");
                window.OwnedForms[0].Opacity = 0;
                window.OwnedForms[0].Close();
                var downloadResult = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", "{\"expression\":\"const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['name,score',String.fromCharCode(10),'Candidate,100'],{type:'text/csv'})); a.download='results.csv'; a.click();\",\"userGesture\":true}");
                Check(!downloadResult.Contains("exceptionDetails"), "Native export test script failed: " + downloadResult);
                await Wait(() => Task.FromResult(File.Exists(Path.Combine(directory, "smoke-export.csv"))), "Native export did not reach the selected file");
                await Wait(() => Task.FromResult(File.ReadAllText(Path.Combine(directory, "smoke-export.csv")).Contains("Candidate,100")), "Native export contents were not preserved");
                core.Navigate("https://example.invalid/");
                await Task.Delay(300);
                Check(DesktopPolicy.IsWorkspace(core.Source, new Uri(origin)), "Embedded browser escaped the Host origin");
                Console.WriteLine("PASS native navigation, in-app links, export bytes and external-navigation restriction");
                var serverProcess = (Process)typeof(HostWindow).GetField("host", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).GetValue(window);
                int serverId = serverProcess.Id;
                var failedView = window.Workspace;
                var crash = core.CallDevToolsProtocolMethodAsync("Page.crash", "{}");
                await Task.WhenAny(crash, Task.Delay(2000));
                if (crash.IsCompleted) { try { await crash; } catch { } }
                await Wait(() => Task.FromResult(!window.Workspace.Visible && window.ServerReady), "Renderer crash did not expose interface recovery");
                typeof(HostWindow).GetMethod("OpenWorkspace", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance, null, Type.EmptyTypes, null).Invoke(window, null);
                await Wait(() => Task.FromResult(window.Workspace != failedView && window.Workspace.Browser.CoreWebView2 != null && window.Workspace.Visible), "Interface retry did not recover WebView2");
                core = window.Workspace.Browser.CoreWebView2;
                await Wait(async () => (await core.ExecuteScriptAsync("Boolean(document.querySelector('.auth-card'))")) == "true", "Recovered interface did not render");
                Check(serverProcess.Id == serverId && !serverProcess.HasExited, "Interface recovery restarted the examination server");
                Check((await core.ExecuteScriptAsync("localStorage.getItem('mudu-native-smoke')")) == "\"kept\"", "Renderer recovery lost the app profile");
                Console.WriteLine("PASS renderer crash recovery preserves server process and app profile");
                using (var capture = File.Create(Path.Combine(directory, "desktop-workspace.png"))) await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, capture);
                window.Close();
                Check(!window.Visible && window.ServerReady, "Closing the window stopped the server instead of hiding to tray");
                using (var client = new WebClient()) Check(client.DownloadString(origin + "/api/health").Contains("ok"), "Host stopped after closing its interface");
                window.Show();
                Check(window.Workspace.Browser.CoreWebView2 == core, "Showing the Host replaced the browser session");
                Console.WriteLine("PASS close-to-tray preserves server and interface session");
                // Test the real graceful shutdown without driving a destructive confirmation dialog.
                var method = typeof(HostWindow).GetMethod("StopHostAsync", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                Check(await (Task<bool>)method.Invoke(window, null), "Native graceful shutdown failed");
                Console.WriteLine("PASS native graceful server shutdown");
                result = 0;
            } catch (Exception error) { Console.Error.WriteLine(error.ToString()); }
            {
                var stop = typeof(HostWindow).GetMethod("StopHostAsync", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                try { await (Task<bool>)stop.Invoke(window, null); } catch { }
                typeof(HostWindow).GetField("quitting", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).SetValue(window, true);
                window.Close();
            }
        };
        Application.Run(window);
        return result;
    }
}
