import { localResourcePath } from './project-files';

export const MEDIA_LIMIT = 25_000_000;
const types: Record<string, string> = {mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg'};
export function localMediaType(path: unknown): string | undefined {
  const normalized=localResourcePath(path);
  const extension=normalized?.split('.').at(-1)!.toLowerCase();
  return extension&&Object.hasOwn(types,extension) ? types[extension] : undefined;
}
export const isTextAttachment = (path: string) => !!localResourcePath(path) && /\.(?:md|markdown|txt|csv|tsv|json|log|yaml|yml|go|js|ts|css)$/i.test(path);

/** Only browser-native media containers; an extension alone is not a file type. */
export function mediaMatches(data: Uint8Array, path: string): boolean {
  const type=localMediaType(path),ascii=(start:number,length:number)=>String.fromCharCode(...data.slice(start,start+length));
  if(type==='video/mp4')return data.length>=12&&ascii(4,4)==='ftyp';
  if(type==='video/webm')return [0x1a,0x45,0xdf,0xa3].every((byte,index)=>data[index]===byte);
  if(type==='audio/wav')return ascii(0,4)==='RIFF'&&ascii(8,4)==='WAVE';
  if(type==='audio/ogg')return ascii(0,4)==='OggS';
  if(type==='audio/mpeg')return ascii(0,3)==='ID3'||data.length>=2&&data[0]===0xff&&(data[1]&0xe0)===0xe0;
  return false;
}
