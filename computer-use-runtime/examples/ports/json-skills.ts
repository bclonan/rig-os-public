import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SkillCapsule } from "../../src/contracts/index.js";
import type { SkillRepository } from "../../src/contracts/ports.js";
import { checkSkill } from "../../src/skills/index.js";
import { durableJson } from "./json-experience.js";

/** Independent skill/version file for the same single trusted coordinator. */
export class JsonSkillRepository implements SkillRepository {
  readonly path: string;
  private data: {
    byId: Record<string, SkillCapsule>;
    byHash: Record<string, SkillCapsule>;
  };
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.data = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : { byId: {}, byHash: {} };
    for (const [digest, value] of Object.entries(this.data.byHash)) {
      checkSkill(value);
      if (digest !== value.hash)
        throw new Error("JSON skill version key mismatch");
    }
    for (const value of Object.values(this.data.byId)) {
      checkSkill(value);
      if (!this.data.byHash[value.hash])
        throw new Error("JSON skill version missing");
    }
  }
  get(id: string) {
    const skill = Object.hasOwn(this.data.byId, id)
      ? this.data.byId[id]
      : undefined;
    if (!skill) throw new Error("Missing JSON skill " + id);
    return checkSkill(JSON.parse(JSON.stringify(skill)));
  }
  list() {
    return Object.keys(this.data.byId).map((id) => this.get(id));
  }
  version(digest: string) {
    const skill = Object.hasOwn(this.data.byHash, digest)
      ? this.data.byHash[digest]
      : undefined;
    if (!skill || skill.hash !== digest)
      throw new Error("Pinned JSON skill is unavailable");
    return checkSkill(JSON.parse(JSON.stringify(skill)));
  }
  put(skill: SkillCapsule) {
    checkSkill(skill);
    for (const dependency of skill.dependencies) this.get(dependency);
    const next = JSON.parse(JSON.stringify(this.data));
    Object.defineProperty(next.byId, skill.id, {
      value: JSON.parse(JSON.stringify(skill)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    next.byHash[skill.hash] = JSON.parse(JSON.stringify(skill));
    durableJson(this.path, next);
    this.data = next;
  }
}
