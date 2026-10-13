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
      const hop = 4;
      expect(uriel.topGuard).toBe(0);
      expect(uriel.homeX).toBeLessThan(width / 2);
      expect(uriel.maxX + uriel.size).toBeLessThanOrEqual(width / 2);
      expect(fonzo.homeX).toBeGreaterThanOrEqual(width / 2);
      expect(fonzo.minX).toBeGreaterThanOrEqual(width / 2);
      expect(fonzo.topGuard).toBeGreaterThanOrEqual(24);
      expect(fonzo.minY + fonzo.topGuard - hop).toBeGreaterThanOrEqual(28);
      expect(uriel.maxY + uriel.size).toBeLessThanOrEqual(height / 2);
      expect(fonzo.maxY + fonzo.size).toBeLessThanOrEqual(height / 2);
      expect(uriel.maxX).toBeLessThan(fonzo.minX);
    }
  });
});
