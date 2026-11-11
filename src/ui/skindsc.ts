/**
 * Skin description: SkinDsc.idd is not an ssi container, it is a plain
 * concatenation of <skin> XML documents (one per pane, in file order).
 *
 * The stage code refers to panes by the same names used in the XML, so the
 * loader keeps the document order and indexes by the pane id found in the
 * `pane="..."` references plus the order the original uses
 * (Login_1P, Login_1P_Multiserver, Login_2P, Login_2P_Multiserver, LoginStage).
 */

export interface SkinElement {
  kind: 'img' | 'button' | 'edit' | 'sel' | 'inner' | 'unknown';
  id: string;
  attrs: Record<string, string>;
  x: number;
  y: number;
  visible: boolean;
  /** resolved image path, e.g. "korea\\LoginTable00.bmp" -> ["korea","LoginTable00.bmp"] */
  imgPath?: string[];
  pane?: string;
}

export interface SkinPane {
  index: number;
  elements: SkinElement[];
}

const ATTR_RE = /([a-zA-Z_]+)="([^"]*)"/g;

function parseElement(tag: string): SkinElement {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) attrs[m[1]!] = m[2]!;
  const nameMatch = /^<([a-zA-Z_]+)/.exec(tag);
  const rawKind = (nameMatch?.[1] ?? '').toLowerCase();
  const kind: SkinElement['kind'] =
    rawKind === 'img' || rawKind === 'button' || rawKind === 'edit' || rawKind === 'sel' || rawKind === 'inner'
      ? (rawKind as SkinElement['kind'])
      : 'unknown';
  const imgPath = attrs.imgpath ? attrs.imgpath.split(/[\\/]/).filter(Boolean) : undefined;
  return {
    kind,
    id: attrs.id ?? '',
    attrs,
    x: Number(attrs.x ?? 0),
    y: Number(attrs.y ?? 0),
    visible: attrs.visible !== '0',
    imgPath,
    pane: attrs.pane,
  };
}

/**
 * SkinDsc.idd is a single XML document sequence.  The pack's index records are
 * each one byte short (entry n starts at the last byte of entry n-1's data),
 * so the client never reads entries individually — it keeps the whole payload
 * and parses every <skin> element in order.  We do the same.
 */
export function parseSkinDsc(text: string): SkinPane[] {
  const panes: SkinPane[] = [];
  const paneRe = /<skin>([\s\S]*?)<\/skin>/g;
  let index = 0;
  for (const pane of text.matchAll(paneRe)) {
    const body = pane[1]!;
    const elements: SkinElement[] = [];
    for (const m of body.matchAll(/<[a-zA-Z_]+[^>]*\/?>/g)) elements.push(parseElement(m[0]));
    panes.push({ index: index++, elements });
  }
  return panes;
}

/** Pane order used by CLoginStage / CSelectServerStage (font of the XML order). */
export const PANE = {
  Login1P: 0,
  Login1PMultiserver: 1,
  Login2P: 2,
  Login2PMultiserver: 3,
  LoginStage: 4,
} as const;
