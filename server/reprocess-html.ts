import path from "node:path";
import { createConfigStore, resolveDataDirectory } from "./config";
import { createApplicationAwareClassifier } from "./application-aware-classifier";
import { createLlmClient } from "./llm";
import { createHtmlEmailReprocessor } from "./reprocess";
import { createRepository } from "./repository";

const dataDirectory = resolveDataDirectory();
const configStore = createConfigStore(path.join(dataDirectory, "config.json"));
const repository = createRepository(path.join(dataDirectory, "orbit.sqlite"));
const llmClient = createLlmClient({ getSettings: () => configStore.get().llm });
const classifier = createApplicationAwareClassifier({ repository, llmClient, getModel: () => configStore.get().llm.model });
const reprocessor = createHtmlEmailReprocessor({
  repository,
  classifier,
});
const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(dataDirectory, "backups", `orbit-before-html-reprocess-${backupTimestamp}.sqlite`);

try {
  const result = await reprocessor.run({
    beforeMutate: () => repository.createBackup(backupPath),
  });
  console.log(JSON.stringify({ backupPath, ...result }));
  if (result.failed > 0) process.exitCode = 1;
} finally {
  repository.close();
}
