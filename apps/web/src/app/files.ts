/** Opening and saving files with the browser's own pickers. */

/** Choose several files at once (a shapefile's .shp, .dbf and .prj, say). */
export function openFilesPicker(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export function openFilePicker(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export function saveTextFile(text: string, name: string): void {
  saveBlob(new Blob([text], { type: 'text/plain' }), name);
}

export function saveBinaryFile(bytes: Uint8Array, name: string): void {
  saveBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), name);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Put text on the clipboard; false if the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Rows as tab-separated text, which spreadsheets paste as cells. */
export function tsv(rows: (string | number)[][]): string {
  return rows
    .map((r) => r.map((c) => (typeof c === 'number' ? String(c) : c.replace(/[\t\n]/g, ' '))).join('\t'))
    .join('\n');
}
