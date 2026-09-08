import { z } from 'zod';

/** Fresh execution namespace prevents accidentally delivering a prior bot's output. */
export function artifactContract(runId: string, version: number) {
  z.uuid().parse(runId);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('INVALID_EXECUTION_VERSION');
  const directory = `${runId}/${version}`;
  return {
    instructions: `If the user requests a downloadable file, create at most one file in /workspace/exports/${directory}/ using file tools. Use a simple filename containing only letters, numbers, dots, underscores or hyphens (maximum 80 characters). Only after writing the file successfully, append exactly [[artifact:filename]] to your final answer. Do not use this marker for existing files outside this execution directory. Do not claim a downloadable attachment unless you created it. For ordinary conversation, omit the marker.`,
    parse(output: string) {
      const markers = [...output.matchAll(/\[\[artifact:([^\]\r\n]*)\]\]/g)];
      if (!markers.length) return { text: output, relativePath: undefined };
      if (markers.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(markers[0][1]) || markers[0][1].includes('..')) {
        throw new Error('INVALID_ARTIFACT_DECLARATION');
      }
      return { text: output.replace(markers[0][0], '').trim() || 'Arquivo pronto para baixar.', relativePath: `${directory}/${markers[0][1]}` };
    },
  };
}
