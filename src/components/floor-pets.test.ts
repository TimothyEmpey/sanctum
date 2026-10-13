import { describe, expect, it } from "vitest";
import { floorQuadrant } from "@/components/floor-pets";

describe("floor quadrants", () => {
  it("keeps Uriel in the upper left and Fonzo in the upper right", () => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [1280, 720],
    ] as const) {
      const uriel = floorQuadrant("uriel", width, height);
      const fonzo = floorQuadrant("fonzo", width, height);
      const size = width < 640 ? 88 : 112;
      expect(uriel.homeX).toBeLessThan(width / 2);
      expect(uriel.maxX + size).toBeLessThanOrEqual(width / 2);
      expect(fonzo.homeX).toBeGreaterThanOrEqual(width / 2);
      expect(fonzo.minX).toBeGreaterThanOrEqual(width / 2);
      expect(uriel.maxY + size).toBeLessThanOrEqual(height / 2);
      expect(fonzo.maxY + size).toBeLessThanOrEqual(height / 2);
      expect(uriel.maxX).toBeLessThan(fonzo.minX);
    }
  });
});
