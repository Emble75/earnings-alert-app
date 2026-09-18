import { NextResponse } from "next/server";

import { TOKEN_COOKIE } from "@/lib/api";

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  const response = NextResponse.redirect(`${origin}/login`, { status: 303 });
  response.cookies.delete(TOKEN_COOKIE);
  return response;
}
