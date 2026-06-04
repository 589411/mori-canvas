/**
 * STT via mori-ear — the universe's single STT provider.
 * Uses the `mori-ear --input <file>` batch CLI: it prints the cleaned transcript
 * to stdout, accepts wav/mp3/m4a/webm/ogg, skips the single-instance lock, and
 * internally routes to the shared local whisper-server (or Groq). We don't
 * reimplement STT — we delegate to ear, exactly as the contract intends.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const execFileP = promisify(execFile)

function earBin(): string {
	if (process.env.MORI_EAR_BIN) return process.env.MORI_EAR_BIN
	const cargo = join(homedir(), '.cargo', 'bin', 'mori-ear')
	return existsSync(cargo) ? cargo : 'mori-ear'
}

/** Transcribe an audio file to text via mori-ear. Throws if ear is missing/fails. */
export async function transcribe(audioPath: string): Promise<string> {
	const { stdout } = await execFileP(earBin(), ['--input', audioPath], {
		timeout: 120_000,
		maxBuffer: 4 << 20,
		// ear reads the Groq key from ~/.mori/config.json itself; env not required.
	})
	return stdout.trim()
}
