import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Standalone } from "@/components/shell";
import { BRAND } from "@/domain/brand";
import { safeNext } from "@/domain/safe-next";
import { signInOf, type SignInMethods } from "@/infrastructure/auth/sign-in";
import { env } from "@/infrastructure/env";
import { PasswordForm } from "./password-form";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = { title: "Sign in" };

/** What Better Auth reports when the account wasn't let in: anything else is the sign-in itself failing. */
const NOT_INVITED = "unable_to_create_user";

/** What the page says first, for the ways this instance has, and to someone who came from an invitation. */
function introOf({ provider, passwords }: SignInMethods, next: string) {
  if (next.startsWith("/join/") && (provider || passwords)) return "Sign in with the invited address, or create your account with it, to join the workspace.";
  if (provider) return `Sign in with your ${provider.name} account to reach your workspace.`;
  return passwords ? "Sign in to reach your workspace." : "Signing in isn’t open on this instance yet.";
}

/** The instance's own ways in, read when the page is asked for: a build doesn't know the instance. */
async function SignIn({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  await connection();
  const ways = signInOf(env());
  const { error, next: asked } = await searchParams;
  const next = safeNext(asked);
  return (
    <>
      <p className="mt-3 max-w-sm text-center text-sm text-muted-foreground">{introOf(ways, next)}</p>
      {ways.provider && (
        <div className="mt-8">
          <SignInButton provider={ways.provider.id} name={ways.provider.name} next={next} />
        </div>
      )}
      {ways.provider && ways.passwords && <p className="mt-6 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">or</p>}
      {ways.passwords && <PasswordForm next={next} />}
      {error && <p className="mt-3 max-w-sm text-center text-sm text-alert">{error === NOT_INVITED ? `This account doesn’t have access to ${BRAND} yet.` : "Signing in failed: try again in a moment."}</p>}
    </>
  );
}

/** Where members sign in, and where an assistant sends them before they approve it. */
export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <Standalone>
      <h1 className="mt-8 text-center text-3xl font-bold tracking-[-0.03em]">
        One support desk, <span className="text-link">for all your products</span>
      </h1>
      <Suspense>
        <SignIn searchParams={searchParams} />
      </Suspense>
    </Standalone>
  );
}
