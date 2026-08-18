/**
 * attach (plan §2.9, design §6.1). /attach takes over the environment shell:
 * exit alternate screen + restore cooked mode → spawn an interactive process
 * (vm/ssh env = `ssh -i <key> <user>@<address>`; docker = `docker exec -it
 * <container> bash`). The TUI is suspended; the SSE pump keeps buffering
 * events; on child exit we re-enter the alternate screen and reflow.
 *
 * The terminal I/O hand-off is environment-specific — this module owns the
 * spawn/restore logic; the app drives when to call it and buffers events.
 */

import { spawn } from 'node:child_process';

export interface AttachTarget {
  kind: 'ssh' | 'docker' | 'local';
  command: string[];
  env?: Record<string, string>;
}

/** Build the attach target from an environment's connection metadata. */
export function targetForEnv(env: {
  kind?: string;
  sshUser?: string;
  sshAddress?: string;
  sshKeyPath?: string;
  container?: string;
}): AttachTarget {
  if (env.kind === 'docker' && env.container) {
    return { kind: 'docker', command: ['docker', 'exec', '-it', env.container, 'bash'] };
  }
  if (env.sshAddress && env.sshUser) {
    const args = ['ssh', '-o', 'StrictHostKeyChecking=no'];
    if (env.sshKeyPath) args.push('-i', env.sshKeyPath);
    args.push(`${env.sshUser}@${env.sshAddress}`);
    return { kind: 'ssh', command: args };
  }
  return { kind: 'local', command: [process.env.SHELL ?? 'bash'] };
}

/**
 * Spawn the interactive process, handing stdin/stdout/stderr through. Resolves
 * when the child exits. Caller must restore the terminal to raw+alt-screen
 * afterwards and trigger a reflow.
 */
export function spawnAttach(target: AttachTarget): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(target.command[0], target.command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, ...(target.env ?? {}) },
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(-1));
  });
}
