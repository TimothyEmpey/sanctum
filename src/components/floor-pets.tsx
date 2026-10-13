"use client";

import { useEffect, useRef, useState } from "react";

type Tone = "live" | "paused" | "halted" | "idle";
type Pose =
  | "idle"
  | "walk"
  | "look"
  | "happy"
  | "sit"
  | "sleep"
  | "eat"
  | "magic"
  | "walk-left"
  | "disappointed";
type Pet = "uriel" | "fonzo";

function spritesFor(pet: Pet): Record<Pose, string> {
  const art = pet === "fonzo" ? "?v=2" : "?v=4";
  return {
    idle: `/${pet}/idle.png${art}`,
    walk: `/${pet}/walk.png${art}`,
    look: `/${pet}/look.png${art}`,
    happy: `/${pet}/happy.png${art}`,
    sit: `/${pet}/sit.png${art}`,
    sleep: `/${pet}/sleep.png${art}`,
    eat: `/${pet}/eat.png${art}`,
    magic: `/${pet}/magic.png${art}`,
    "walk-left": `/${pet}/walk-left.png${art}`,
    disappointed: `/${pet}/disappointed.png${art}`,
  };
}

function moods(pet: Pet, tone: Tone): Pose[] {
  if (tone === "halted") return ["disappointed", "sit", "look"];
  if (tone === "paused") return ["sit", "look", "idle"];
  if (pet === "uriel") return ["idle", "look"];
  return ["happy", "magic", "look", "idle", "eat", "sit"];
}

function pick<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

/** Empty space above Fonzo's art so the hat and the walk hop stay on screen. Matches .fonzo-pet in globals.css. */
export function petBox(pet: Pet, width: number) {
  const narrow = width < 640;
  const art = narrow ? 88 : 112;
  const topGuard = pet === "fonzo" ? (narrow ? 24 : 28) : 0;
  return { art, topGuard, size: art + topGuard, margin: narrow ? 8 : 12 };
}

/** Uriel stays in the upper-left quadrant. Fonzo stays in the upper-right. */
export function floorQuadrant(pet: Pet, width: number, height: number) {
  const { size, margin, topGuard } = petBox(pet, width);
  const minY = margin;
  let maxY = height / 2 - size - margin;
  if (maxY < minY) maxY = minY;
  if (pet === "uriel") {
    const minX = margin;
    const maxX = Math.max(minX, width / 2 - size - margin);
    return { minX, maxX, minY, maxY, homeX: minX, homeY: minY, size, topGuard };
  }
  const edge = Math.max(margin, width - size - margin);
  const minX = Math.min(width / 2, edge);
  const maxX = Math.max(minX, edge);
  return { minX, maxX, minY, maxY, homeX: maxX, homeY: minY, size, topGuard };
}

function quadrant(pet: Pet) {
  return floorQuadrant(pet, window.innerWidth, window.innerHeight);
}

export function FloorPets({ fonzoTone, urielTone }: { fonzoTone: Tone; urielTone: Tone }) {
  return (
    <>
      <FloorPet pet="fonzo" tone={fonzoTone} />
      <FloorPet pet="uriel" tone={urielTone} />
    </>
  );
}

function FloorPet({ pet, tone }: { pet: Pet; tone: Tone }) {
  const sprite = spritesFor(pet);
  const toneRef = useRef(tone);
  toneRef.current = tone;
  const roamRef = useRef<() => void>(() => {});
  const petRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const posRef = useRef({ x: 0, y: 0 });
  const [pose, setPose] = useState<Pose>("idle");
  const [flip, setFlip] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [travel, setTravel] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const place = (next: { x: number; y: number }, ms: number) => {
      posRef.current = next;
      setPos(next);
      setTravel(ms);
    };
    let stopped = false;
    const later = (fn: () => void, ms: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!stopped) fn();
      }, ms);
    };
    const emote = () => {
      const next = pick(moods(pet, toneRef.current));
      setPose(next);
      const hold = pet === "uriel" ? 700 + Math.random() * 900 : 1600 + Math.random() * 2200;
      later(() => roamRef.current(), hold);
    };
    const roam = () => {
      if (media.matches) return;
      const area = quadrant(pet);
      const current = posRef.current;
      let dest = current;
      let dist = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const goHome = attempt > 0 && Math.random() < 0.18;
        dest = {
          x: goHome ? area.homeX : area.minX + Math.random() * (area.maxX - area.minX),
          y: goHome ? area.homeY : area.minY + Math.random() * (area.maxY - area.minY),
        };
        dist = Math.hypot(dest.x - current.x, dest.y - current.y);
        if (dist >= 8) break;
      }
      if (dist < 4) {
        emote();
        return;
      }
      const left = dest.x < current.x;
      setFlip(left);
      setPose(left ? "walk-left" : "walk");
      const ms = Math.min(6800, Math.max(900, (dist / 70) * 1000));
      place(dest, ms);
      later(emote, ms + 30);
    };
    roamRef.current = roam;

    const home = quadrant(pet);
    place({ x: home.homeX, y: home.homeY }, 0);
    setPose(media.matches ? (toneRef.current === "halted" ? "disappointed" : toneRef.current === "paused" ? "sit" : "idle") : "idle");
    setReady(true);
    if (!media.matches) later(roam, pet === "fonzo" ? 600 : 1100);

    const onPet = (event: PointerEvent) => {
      const node = petRef.current;
      if (!node || media.matches) return;
      const rect = node.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) return;
      setPose("happy");
      setTravel(0);
      later(() => roamRef.current(), 1400);
    };
    const onResize = () => {
      const area = quadrant(pet);
      const current = posRef.current;
      place(
        {
          x: Math.min(Math.max(area.minX, current.x), area.maxX),
          y: Math.min(Math.max(area.minY, current.y), area.maxY),
        },
        0,
      );
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointerdown", onPet);
    return () => {
      stopped = true;
      window.clearTimeout(timer.current);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointerdown", onPet);
    };
  }, [pet]);

  const walking = pose === "walk" || pose === "walk-left";
  const homeClass = pet === "fonzo" ? "floor-pet-fonzo" : "floor-pet-uriel";
  const frame = pet === "fonzo" ? "uriel-pet fonzo-pet" : "uriel-pet";

  return (
    <div
      ref={petRef}
      className={ready ? frame : `${frame} ${homeClass}`}
      data-floor-pet={pet}
      style={
        ready
          ? { transform: `translate(${pos.x}px, ${pos.y}px)`, transition: travel > 0 ? `transform ${travel}ms linear` : "none", zIndex: pet === "uriel" ? 41 : 40 }
          : undefined
      }
      aria-hidden
    >
      <div className={walking ? "uriel-hop" : "uriel-stand"}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="uriel-sprite" src={sprite[pose]} alt="" style={flip ? { transform: "scaleX(-1)" } : undefined} />
      </div>
    </div>
  );
}
