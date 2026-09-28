export function resultsDisposition(title: string): string {
  const stem =
    Array.from(
      title
        .normalize('NFC')
        .replace(/[\x00-\x1f\x7f-\x9f<>:"/\\|?*]/g, '-')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, 120)
      .join('')
      .replace(/[. ]+$/g, '') || 'Assessment';
  const filename = `${stem} - results.csv`;
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
