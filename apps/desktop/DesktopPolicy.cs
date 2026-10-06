using System;

// The embedded browser is a view of this Host, never a general-purpose browser.
internal static class DesktopPolicy {
    public static bool IsWorkspace(string address, Uri origin) {
        Uri uri;
        return Uri.TryCreate(address, UriKind.Absolute, out uri)
            && uri.Scheme == origin.Scheme && uri.Host == origin.Host
            && uri.Port == origin.Port && String.IsNullOrEmpty(uri.UserInfo);
    }
    public static bool IsDownload(string address, Uri origin) {
        return IsWorkspace(address, origin)
            || (address != null && address.StartsWith("blob:", StringComparison.Ordinal)
                && IsWorkspace(address.Substring(5), origin));
    }
    public static bool IsExternal(string address) {
        Uri uri;
        return Uri.TryCreate(address, UriKind.Absolute, out uri)
            && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
            && String.IsNullOrEmpty(uri.UserInfo);
    }
}
