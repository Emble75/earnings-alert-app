/**
 * Login route handler.
 *
 * The backend token is stored in an httpOnly cookie: it never reaches
 * client-side JavaScript, so an XSS bug cannot exfiltrate it.
 */

import { NextResponse } from "next/server";

import { ApiRequestError, TOKEN_COOKIE, login } from "@/lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const origin = new URL(request.url).origin;

  try {
    const token = await login(email, password);
    const response = NextResponse.redirect(`${origin}/dashboard`, { status: 303 });
    response.cookies.set(TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 12,
    });
    return response;
  } catch (error) {
    const message =
      error instanceof ApiRequestError ? error.message : "could not reach the backend";
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(message)}`,
      { status: 303 },
    );
  }
}
