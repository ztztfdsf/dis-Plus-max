export function encodeFile(file: File, salt: string): Promise<File>;
export function decodeFile(file: Blob, salt: string): Promise<Blob>;
