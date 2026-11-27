// Lecture d'archives ZIP, sans dependance, pour l'import de packs d'images.
//
// SECURITE : une archive est une donnee hostile. On ne cree JAMAIS de fichier a partir du nom d'une entree (aucun risque de « zip slip » : les noms ne servent qu'a l'affichage et
// comme indice de classement) ; l'archive reste sur le disque et chaque entree est lue et decompressee a la demande, avec des bornes strictes : nombre d'entrees, taille
// decompressee de chaque entree (declaree ET reellement produite), verification du CRC. Zip64, entrees chiffrees et methodes autres que stockee / deflate sont ignores.
import { open } from 'node:fs/promises'
import { crc32, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const inflate = promisify(inflateRaw)

export interface ZipEntry {
  /** Chemin interne nettoye (separateur /, sans « .. » ni caracteres de controle), pour l'affichage et le classement. */
  name: string
  size: number
  compressedSize: number
  method: number
  crc: number
  offset: number
  /** Raison pour laquelle l'entree ne sera pas lue (dossier, chiffree, methode inconnue, trop grosse...), sinon null. */
  skip: 'directory' | 'encrypted' | 'unsupported' | 'too-big' | null
}

export class ZipError extends Error {}

export interface ZipLimits { maxEntries: number; maxEntryBytes: number }

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o)
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o)

/** Nom d'entree nettoye : chemin relatif, sans « .. », sans caracteres de controle, 200 caracteres au plus. */
export function cleanEntryName(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').split('/').filter((p) => p && p !== '.' && p !== '..').join('/').slice(0, 200)
}

/** Liste les entrees d'une archive (repertoire central). */
export async function listZip(path: string, limits: ZipLimits): Promise<ZipEntry[]> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    if (size < 22) throw new ZipError("Ce fichier n'est pas une archive ZIP.")
    const tailLen = Math.min(size, 22 + 65535)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) throw new ZipError("Ce fichier n'est pas une archive ZIP (ou elle est corrompue).")
    const total = u16(tail, eocd + 10)
    const cdSize = u32(tail, eocd + 12)
    const cdOffset = u32(tail, eocd + 16)
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('Les archives ZIP64 (plus de 65 535 fichiers ou plus de 4 Go) ne sont pas prises en charge : decoupe le pack en plusieurs archives.')
    if (total > limits.maxEntries) throw new ZipError(`Archive trop riche : ${total} fichiers (${limits.maxEntries} au plus). Decoupe le pack en plusieurs archives.`)
    if (cdSize > 32 * 1024 * 1024 || cdOffset + cdSize > size) throw new ZipError('Archive ZIP corrompue (repertoire central invalide).')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const out: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < total; n++) {
      if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ZipError('Archive ZIP corrompue (entree illisible).')
      const flags = u16(cd, p + 8)
      const method = u16(cd, p + 10)
      const crc = u32(cd, p + 16)
      const compressedSize = u32(cd, p + 20)
      const usize = u32(cd, p + 24)
      const nameLen = u16(cd, p + 28)
      const extraLen = u16(cd, p + 30)
      const commentLen = u16(cd, p + 32)
      const offset = u32(cd, p + 42)
      if (p + 46 + nameLen > cd.length) throw new ZipError('Archive ZIP corrompue (nom illisible).')
      const rawName = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
      p += 46 + nameLen + extraLen + commentLen
      const isDir = rawName.endsWith('/') || rawName.endsWith('\\')
      const name = cleanEntryName(rawName)
      let skip: ZipEntry['skip'] = null
      if (isDir || !name) skip = 'directory'
      else if (flags & 1) skip = 'encrypted'
      else if (method !== 0 && method !== 8) skip = 'unsupported'
      else if (usize === 0xffffffff || compressedSize === 0xffffffff) skip = 'unsupported'
      else if (usize > limits.maxEntryBytes || compressedSize > limits.maxEntryBytes + 1024) skip = 'too-big'
      out.push({ name, size: usize, compressedSize, method, crc, offset, skip })
    }
    return out
  } finally { await fh.close() }
}

/** Contenu d'une entree : decompression bornee a la taille declaree, CRC verifie. Leve ZipError si l'entree ment ou est corrompue. */
export async function readZipEntry(path: string, e: ZipEntry): Promise<Buffer> {
  if (e.skip) throw new ZipError(`Entree ignoree (${e.skip}).`)
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(30)
    const r = await fh.read(head, 0, 30, e.offset)
    if (r.bytesRead < 30 || u32(head, 0) !== 0x04034b50) throw new ZipError('Entree corrompue (en-tete local).')
    const start = e.offset + 30 + u16(head, 26) + u16(head, 28)
    const comp = Buffer.alloc(e.compressedSize)
    const rr = await fh.read(comp, 0, e.compressedSize, start)
    if (rr.bytesRead < e.compressedSize) throw new ZipError('Entree tronquee.')
    let data: Buffer
    if (e.method === 0) data = comp
    else {
      try { data = await inflate(comp, { maxOutputLength: e.size + 1 }) } catch { throw new ZipError('Entree corrompue ou plus grosse que declare.') }
    }
    if (data.length !== e.size) throw new ZipError('Entree corrompue (taille differente de celle declaree).')
    if (crc32(data) !== e.crc) throw new ZipError('Entree corrompue (CRC invalide).')
    return data
  } finally { await fh.close() }
}
