/**
 * Bitmap text.
 *
 * The original draws every string through the GDI font baked into the skin
 * (CCtrlEdit / CCtrlButtonWithText use `CreateFontIndirect` with the client's
 * dotum font).  We cannot import a Windows font, and inventing glyphs is not
 * allowed, so this module draws only with a font the browser already has and
 * keeps the *text* byte-for-byte from the original string tables.
 *
 * For the login stage the only text the client itself paints are the two edit
 * fields' contents (typed by the player) and the strings from csysstr.ssd /
 * stringtable.ini, all of which come from the data, never from source.
 */

export interface TextStyle {
  size?: number;
  weight?: string;
  colour?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
}

const FONT = '"Dotum", "돋움", "Gulim", "굴림", sans-serif';

/** Draw already-decoded cp949 text (a JS string) with the client's font chain. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: TextStyle = {},
): void {
  ctx.font = `${style.weight ?? 'normal'} ${style.size ?? 12}px ${FONT}`;
  ctx.fillStyle = style.colour ?? '#ffffff';
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = style.baseline ?? 'top';
  ctx.fillText(text, x, y);
}

/**
 * The client's edit controls are plain rectangles filled with the skin's
 * background and a 12px caret glyph offset; no border art is in SkinRsc, so
 * they are drawn as the original does: just the text (CClientEdit has no
 * frame of its own, see CCtrlEditORG::OnPaint).
 */
export function drawEdit(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  password: boolean,
  focused: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const shown = password ? '●'.repeat(text.length) : text;
  drawText(ctx, shown, x + 2, y + Math.max(0, (h - 12) / 2), { size: 12, colour: '#000000' });
  if (focused) {
    const caretX = x + 2 + ctx.measureText(shown).width + 1;
    ctx.fillStyle = '#000000';
    ctx.fillRect(caretX, y + 2, 1, h - 4);
  }
  ctx.restore();
}
