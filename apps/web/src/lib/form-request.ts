/** Whether a request's body is `application/x-www-form-urlencoded`, which may name a charset. */
export function isFormRequest(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/x-www-form-urlencoded";
}
