import type { FaceFamily } from "../../map/assistantAlerts";

const families = {
  happy: { label: "Happy", eyes: "arc", mouth: "smile", brow: 0, tint: "#d4e9ff" },
  bright: { label: "Delighted", eyes: "big", mouth: "openSmile", brow: 1, tint: "#e4cfff" },
  watchful: { label: "Watchful", eyes: "upright", mouth: "line", brow: 1, tint: "#d7e7ff" },
  rain: { label: "Rain concern", eyes: "slant", mouth: "frown", brow: -1, tint: "#a8e3ff" },
  flood: { label: "Flood concern", eyes: "big", mouth: "open", brow: -1, tint: "#fdddba" },
  traffic: { label: "Traffic focus", eyes: "flat", mouth: "line", brow: 2, tint: "#ffebaa" },
  urgent: { label: "Urgent focus", eyes: "slant", mouth: "open", brow: 2, tint: "#ffb7c0" },
} satisfies Record<FaceFamily, { label: string; eyes: string; mouth: string; brow: number; tint: string }>;

const variations = [
  { label: "front", shift: 0, scale: 1, tension: 1, tilt: 0, asymmetry: 0 },
  { label: "eyes left", shift: -9, scale: .82, tension: .78, tilt: -.12, asymmetry: .12 },
  { label: "eyes right", shift: 9, scale: .87, tension: .83, tilt: .12, asymmetry: -.12 },
  { label: "wide-eyed", shift: 0, scale: 1.31, tension: 1.45, tilt: -.045, asymmetry: .07 },
  { label: "soft gaze", shift: -3, scale: .68, tension: .55, tilt: .04, asymmetry: .08 },
  { label: "raised brow", shift: 3, scale: 1.12, tension: 1.15, tilt: -.072, asymmetry: .36 },
  { label: "thinking tilt", shift: -6, scale: .91, tension: .67, tilt: .19, asymmetry: -.28 },
  { label: "half blink", shift: 5, scale: .54, tension: 1.24, tilt: -.15, asymmetry: .3 },
] as const;

export const expressions = Object.entries(families).flatMap(([family, profile]) =>
  variations.map((variation) => ({
    ...profile,
    ...variation,
    family,
    label: `${profile.label} · ${variation.label}`,
  })),
);

export type MascotExpression = typeof expressions[number];

export function drawFace(ctx: CanvasRenderingContext2D, face: MascotExpression, gazeX = 0, gazeY = 0) {
  ctx.clearRect(0, 0, 256, 144);
  ctx.strokeStyle = face.tint;
  ctx.fillStyle = face.tint;
  ctx.lineCap = "round";
  ctx.lineWidth = 6;

  for (const side of [-1, 1]) {
    const x = 128 + side * 41 + face.shift + gazeX;
    const y = 61 + side * face.asymmetry * 11 + gazeY;
    const rise = (face.scale + side * face.asymmetry / 2) * 12;
    ctx.beginPath();
    if (face.eyes === "arc") {
      ctx.moveTo(x - 15, y + 5);
      ctx.quadraticCurveTo(x, y - rise * 2, x + 15, y + 5);
      ctx.stroke();
    } else if (face.eyes === "flat" || face.eyes === "slant") {
      const slope = face.eyes === "slant" ? side * rise * .65 : side * face.asymmetry * 6;
      ctx.moveTo(x - 13, y - slope);
      ctx.quadraticCurveTo(x, y + rise * .65, x + 13, y + slope);
      ctx.stroke();
    } else {
      ctx.ellipse(x, y, face.eyes === "big" ? 9 : 6, Math.max(3, rise), 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (face.brow !== 0) {
      const lift = 21 + (face.scale - 1) * 10;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x - 11, y - lift + side * face.brow * 3);
      ctx.quadraticCurveTo(x, y - lift - 5, x + 11, y - lift - side * face.brow * 3);
      ctx.stroke();
      ctx.lineWidth = 6;
    }
  }

  const mx = 128 + face.shift * .55;
  const my = 103;
  const width = 15 * face.tension;
  ctx.beginPath();
  if (face.mouth === "open") {
    ctx.ellipse(mx, my, Math.max(5, width * .62), 8 * face.scale, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(mx - width, my);
    const bend = face.mouth === "frown" ? -14 : face.mouth === "line" ? 2 : 17;
    ctx.quadraticCurveTo(mx, my + bend * face.tension, mx + width, my);
    if (face.mouth === "openSmile") ctx.quadraticCurveTo(mx, my + 4, mx - width, my);
  }
  ctx.stroke();
}
