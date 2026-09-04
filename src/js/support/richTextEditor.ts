export interface RichTextEditor {
  getHtml(): string;
  getCharacterCount(): number;
  refresh(): void;
  clear(): void;
  focus(): void;
}

function plainText(editor: HTMLElement): string {
  return (editor.innerText || editor.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function insertPlainText(value: string): void {
  // execCommand remains the broadly supported way to insert text at the active
  // caret in a contenteditable element. The server sanitizes the submitted HTML
  // again, so this is only a convenience/security layer for pasted content.
  document.execCommand('insertText', false, value);
}

export function initRichTextEditor(input: {
  editor: HTMLElement;
  toolbar: HTMLElement;
  count: HTMLElement;
  minimumCharacters: number;
  countLabel?: (count: number, minimumCharacters: number) => string;
  linkPrompt?: () => string;
}): RichTextEditor {
  const updateCount = () => {
    const count = Array.from(plainText(input.editor)).length;
    input.count.textContent = input.countLabel
      ? input.countLabel(count, input.minimumCharacters)
      : `${count} / minimal ${input.minimumCharacters} karakter`;
    input.count.classList.toggle(
      'text-red-600',
      count > 0 && count < input.minimumCharacters
    );
    input.count.classList.toggle(
      'text-emerald-700',
      count >= input.minimumCharacters
    );
    input.count.classList.toggle(
      'text-on-surface-variant',
      count === 0 || count < input.minimumCharacters
    );
  };

  input.toolbar.addEventListener('mousedown', (event) => {
    // Keep the active text selection when a toolbar button is clicked.
    event.preventDefault();
  });
  input.toolbar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-editor-command]'
    );
    if (!target) return;
    input.editor.focus();
    const command = target.dataset.editorCommand;
    if (!command) return;
    if (command === 'createLink') {
      const href = window.prompt(
        input.linkPrompt?.() || 'Masukkan tautan https:// atau mailto:'
      );
      if (!href) return;
      try {
        const parsed = new URL(href, window.location.origin);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return;
      } catch {
        return;
      }
      document.execCommand('createLink', false, href);
    } else {
      document.execCommand(command, false);
    }
    updateCount();
  });

  input.editor.addEventListener('paste', (event) => {
    event.preventDefault();
    insertPlainText(event.clipboardData?.getData('text/plain') || '');
    updateCount();
  });
  input.editor.addEventListener('drop', (event) => event.preventDefault());
  input.editor.addEventListener('input', updateCount);
  updateCount();

  return {
    getHtml: () => input.editor.innerHTML,
    getCharacterCount: () => Array.from(plainText(input.editor)).length,
    refresh: updateCount,
    clear: () => {
      input.editor.textContent = '';
      updateCount();
    },
    focus: () => input.editor.focus(),
  };
}
