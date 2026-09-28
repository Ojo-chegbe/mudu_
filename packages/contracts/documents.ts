export const documentExtensions = ['pdf', 'docx', 'pptx', 'odt', 'txt', 'md'] as const;
export const documentAccept = documentExtensions.map((extension) => `.${extension}`).join(',');
export const maxDocumentBytes = 10 * 1024 * 1024;
export const maxExtractedCharacters = 300000;
export const maxGenerationCharacters = 60000;
export interface ExtractedDocument {
  name: string;
  text: string;
  units: number | null;
  unitLabel: 'pages' | 'slides' | null;
  warnings: string[];
}
