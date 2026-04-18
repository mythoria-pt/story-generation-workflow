declare module 'hyphen/*' {
  export function hyphenateHTMLSync(
    html: string,
    options?: {
      exceptions?: string[];
      hyphenChar?: string;
      minWordLength?: number;
    },
  ): string;
}
