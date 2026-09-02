import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const settingsSchema = z.object({
  imap: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string(),
    password: z.string(),
    folder: z.string().min(1),
  }),
  llm: z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string(),
  }),
  ocr: z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string(),
  }),
  syncIntervalMinutes: z.number().int().min(1),
});

export type OrbitSettings = z.infer<typeof settingsSchema>;

export interface PublicSettings {
  imap: Omit<OrbitSettings["imap"], "password"> & { hasPassword: boolean };
  llm: Omit<OrbitSettings["llm"], "apiKey"> & { hasApiKey: boolean };
  ocr: Omit<OrbitSettings["ocr"], "apiKey"> & { hasApiKey: boolean };
  syncIntervalMinutes: number;
}

const DEFAULT_OCR = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.8-flash",
  apiKey: "",
};

const DEFAULT_SETTINGS: OrbitSettings = {
  imap: {
    host: "",
    port: 993,
    secure: true,
    username: "",
    password: "",
    folder: "INBOX",
  },
  llm: {
    baseUrl: "",
    model: "",
    apiKey: "",
  },
  ocr: DEFAULT_OCR,
  syncIntervalMinutes: 60,
};

export function resolveDataDirectory() {
  return path.resolve(process.env.ORBIT_DATA_DIR || "data");
}

export function createConfigStore(configPath = path.join(resolveDataDirectory(), "config.json")) {
  function get(): OrbitSettings {
    if (!existsSync(configPath)) return structuredClone(DEFAULT_SETTINGS);
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as Partial<OrbitSettings>;
    return settingsSchema.parse({ ...DEFAULT_SETTINGS, ...stored, ocr: { ...DEFAULT_OCR, ...stored.ocr } });
  }

  type SaveSettingsInput = Omit<OrbitSettings, "ocr"> & { ocr?: OrbitSettings["ocr"] };

  function save(settings: SaveSettingsInput) {
    const validated = settingsSchema.parse({ ...settings, ocr: { ...DEFAULT_OCR, ...settings.ocr } });
    mkdirSync(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
    return validated;
  }

  function getPublic(): PublicSettings {
    const settings = get();
    const { password: _password, ...imap } = settings.imap;
    const { apiKey: _apiKey, ...llm } = settings.llm;
    const { apiKey: _ocrApiKey, ...ocr } = settings.ocr;
    return {
      imap: { ...imap, hasPassword: Boolean(settings.imap.password) },
      llm: { ...llm, hasApiKey: Boolean(settings.llm.apiKey) },
      ocr: { ...ocr, hasApiKey: Boolean(settings.ocr.apiKey) },
      syncIntervalMinutes: settings.syncIntervalMinutes,
    };
  }

  return { get, getPublic, save };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;
