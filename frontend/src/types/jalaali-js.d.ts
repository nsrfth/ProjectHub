declare module 'jalaali-js' {
  // Only the conversion functions we actually call. Add more if usage grows.
  export function toJalaali(
    gy: number,
    gm: number,
    gd: number,
  ): { jy: number; jm: number; jd: number };
  export function toGregorian(
    jy: number,
    jm: number,
    jd: number,
  ): { gy: number; gm: number; gd: number };
}
