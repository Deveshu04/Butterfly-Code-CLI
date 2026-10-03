import { z } from "zod"
import type { ToolDefinition } from "../tool/registry"
import { draftSkills, listSkills, readSkill, skillsIndex } from "./skills"

export const skillToolInput = z.object({
  name: z.string().optional().describe("Skill to load. Omit to list available skills."),
})

/** Progressive disclosure: list = L0 index; name = L1 body. */
export function createSkillTool(opts: {
  dirs: string[]
}): ToolDefinition<z.infer<typeof skillToolInput>> {
  return {
    name: "skill",
    description:
      "Load a stored procedure (skill). Without a name: list available skills. With a name: return the full skill body to follow step by step.",
    inputSchema: skillToolInput,
    async execute(input) {
      if (!input.name) {
        const index = skillsIndex(opts.dirs)
        const drafts = draftSkills(opts.dirs)
        const draftBlock =
          drafts.length === 0
            ? ""
            : `\n\nunverified drafts (self-written; double-check each step):\n${drafts
                .map((skill) => `${skill.name} — ${skill.description}`)
                .join("\n")}`
        const text = `${index}${draftBlock}`.trim()
        return { output: text === "" ? "No skills available yet." : text }
      }
      const body = readSkill(opts.dirs, input.name)
      if (body === null) {
        const known = listSkills(opts.dirs)
          .map((skill) => skill.name)
          .join(", ")
        return {
          output: `No skill named "${input.name}".${known ? ` Known skills: ${known}.` : ""}`,
          isError: true,
        }
      }
      return { output: body }
    },
  }
}
