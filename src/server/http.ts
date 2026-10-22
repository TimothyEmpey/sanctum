const loopback=(hostname:string)=>["localhost","127.0.0.1","[::1]"].includes(hostname);
export function localMutation(request:Request) {
  // Next may normalize request.url to localhost while the browser uses 127.0.0.1.
  // Validate the direct Host header, never an untrusted forwarded-host header.
  const internal=new URL(request.url),host=request.headers.get("host")??internal.host;
  const publicUrl=new URL(`${internal.protocol}//${host}`),origin=request.headers.get("origin");
  if(!loopback(internal.hostname) || !loopback(publicUrl.hostname) || publicUrl.host!==host || origin!==publicUrl.origin) throw new Error("Only same-origin local controls are accepted.");
}
