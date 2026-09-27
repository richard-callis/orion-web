export declare const PROMPTS_DIR: string
export declare const OUTPUT_FILE: string
export declare function collectPrompts(dir?: string): Record<string, string>
export declare function renderModule(prompts: Record<string, string>): string
