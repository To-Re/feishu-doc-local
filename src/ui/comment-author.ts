/** Keep raw cloud identities in the review data; they are not display names. */
export function displayAuthor(author:string,fromCloud:boolean) {
  return fromCloud&&/^(?:ou_|on_|cli_)[A-Za-z0-9_-]+$/.test(author)?'飞书用户':author;
}
