/** Message for skipped binary file contents. */
export const binarySkipped = (size: number) =>
  `<binary content skipped (${size} bytes)>`;

/** Message for skipped large files. */
export const tooLargeSkipped = (size: number) =>
  `<skipped: too large (${size} bytes)>`;

/** Message for read errors when loading file contents. */
export const readError = (msg: string) => `<read error: ${msg}>`;
