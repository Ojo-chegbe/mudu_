using System;

internal static class DesktopPolicyTests {
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static int Main() {
        var origin = new Uri("http://127.0.0.1:4310");
        Check(DesktopPolicy.IsWorkspace("http://127.0.0.1:4310/assessments/new?tab=questions", origin), "MUDU pages must stay in the app");
        Check(DesktopPolicy.IsWorkspace("http://127.0.0.1:4310/account/recovery#token_hash=proof", origin), "Recovery links must remain inside the correct Host");
        foreach (var address in new [] { "http://127.0.0.1:4311/", "http://localhost:4310/", "https://127.0.0.1:4310/", "http://127.0.0.1:4310.evil.test/", "http://127.0.0.1:4310@evil.test/", "http://user@127.0.0.1:4310/", "file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,secret", "about:blank", "mudu://run", "not a URL" }) {
            Check(!DesktopPolicy.IsWorkspace(address, origin), "Unsafe embedded navigation accepted: " + address);
        }
        Check(DesktopPolicy.IsDownload("http://127.0.0.1:4310/api/results.csv", origin), "Host exports should download");
        Check(DesktopPolicy.IsDownload("blob:http://127.0.0.1:4310/export-id", origin), "Browser-generated exports should download");
        Check(!DesktopPolicy.IsDownload("blob:https://evil.test/export", origin), "External blob download accepted");
        Check(!DesktopPolicy.IsDownload("data:text/csv,secret", origin), "Untrusted data download accepted");
        Check(!DesktopPolicy.IsDownload("https://evil.test/program.exe", origin), "External download accepted");
        Check(DesktopPolicy.IsExternal("https://learn.microsoft.com/"), "Ordinary HTTPS links should open in the external browser");
        foreach (var address in new [] { "file:///C:/secret", "javascript:alert(1)", "cmd:run", "https://user:password@evil.test/" }) {
            Check(!DesktopPolicy.IsExternal(address), "Unsafe shell navigation accepted: " + address);
        }
        Console.WriteLine("PASS desktop navigation and download boundaries");
        return 0;
    }
}
