/**
 * Tolerant version comparison for WordPress core/plugin/theme versions.
 * Handles: 6.4.2, 5.7.2-beta1, 1.0.0-rc1, 20241001.1, trailing junk,
 * missing parts (6.4 == 6.4.0), and non-numeric segments.
 * Returns >0 if a > b, <0 if a < b, 0 if equal (within tolerance).
 */
export function compareVersions(a: string, b: string): number {
  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? { num: 0, str: '' };
    const y = pb[i] ?? { num: 0, str: '' };
    if (x.num !== y.num) return x.num < y.num ? -1 : 1;
    // Same numeric prefix — compare prerelease-ish string segment.
    // '' (release) > any suffix: 6.4.2 > 6.4.2-beta1.
    if (x.str !== y.str) {
      if (x.str === '') return 1;
      if (y.str === '') return -1;
      return x.str < y.str ? -1 : 1;
    }
  }
  return 0;
}

interface Part {
  num: number;
  str: string;
}

function normalize(v: string): Part[] {
  // Split on dots and the first hyphen/underscore/plus boundary per segment.
  const cleaned = v.trim().replace(/^v/i, '');
  const segments = cleaned.split(/[.+\s]+/);
  const out: Part[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const m = /^(\d*)(.*)$/.exec(seg) ?? ['', '0', seg];
    const num = m[1] === '' ? 0 : Number(m[1]);
    let str = m[2];
    // A suffix on a segment belongs to that segment's comparison; keep it
    // lowercase and strip leading separators for stable ordering.
    str = str.replace(/^[-_]/, '').toLowerCase();
    out.push({ num: Number.isFinite(num) ? num : 0, str });
    // If the suffix was a prerelease marker attached to a numeric segment
    // (e.g. "2-beta1"), it already lives in `str` of this part.
  }
  return out;
}

/** True when `detected` is older than `latest` (both tolerant-parsed). */
export function isOutdated(detected: string | null | undefined, latest: string | null | undefined): boolean {
  if (!detected || !latest) return false; // unknown → never claim outdated
  return compareVersions(detected, latest) < 0;
}
