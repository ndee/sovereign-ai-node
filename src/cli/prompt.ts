import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export const promptText = async (question: string, defaultValue?: string): Promise<string> => {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer.length === 0 ? (defaultValue ?? "") : answer;
  } finally {
    rl.close();
  }
};

export const promptChoice = async <T extends string>(
  question: string,
  allowed: T[],
  defaultValue: T,
): Promise<T> => {
  while (true) {
    const answer = (await promptText(question, defaultValue)).trim().toLowerCase();
    const matched = allowed.find((entry) => entry.toLowerCase() === answer);
    if (matched !== undefined) {
      return matched;
    }
  }
};
