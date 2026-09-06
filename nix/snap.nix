# The Snap CLI as a Nix derivation.
#
# Strategy: buildNpmPackage reproduces the project's own build
# (`npm ci` from package-lock.json, then the esbuild bundle step, which
# compiles src/main.ts into a single self-contained dist/main.mjs —
# `effect`/`@effect/*` are compiled in and the entry imports only Node
# builtins). The installed package is therefore just the one .mjs file
# plus a `snap` wrapper that invokes it with Node; node_modules never
# ships.
#
# No postinstall scripts matter here: the project declares none, and
# esbuild runs from its prebuilt platform binary (@esbuild/<platform>,
# fetched as an optional dependency per the lockfile), so the sandbox
# needs no network at build time beyond the fixed-output npm fetch.

{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
  src,
}:

buildNpmPackage {
  pname = "snap";
  version = "1.0.0";

  inherit src nodejs;

  # Fetched from package-lock.json in a fixed-output derivation; `nix build`
  # reports the expected hash on any mismatch.
  npmDepsHash = "sha256-D3AShVWe0d9pgEu0G5irnMXAwEUOg77VK4Huz4LSczk=";

  # package.json's `build` script runs typecheck + bundle; in the sandbox
  # the bundle alone is what produces the artifact (typecheck already
  # gates the dev tree).
  npmBuild = "npm run bundle";

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/snap $out/bin
    cp dist/main.mjs $out/lib/snap/main.mjs

    makeWrapper ${nodejs}/bin/node $out/bin/snap \
      --add-flags "$out/lib/snap/main.mjs"

    runHook postInstall
  '';

  meta = {
    description = "Snap — deterministic replay version control (TypeScript CLI)";
    longDescription = ''
      Snap identifies versions by vector clocks and materializes any known
      version by canonically replaying patches, resolving every conflict
      automatically (line-level OT for concurrent text edits, fixed
      tie-break rules otherwise). This package installs the TypeScript
      implementation as the `snap` command.
    '';
    # The project has not declared a license yet; set meta.license here
    # when it does (leaving it unset avoids making any claim and does not
    # trip nixpkgs' unfree gate for this flake-local package).
    mainProgram = "snap";
    platforms = lib.platforms.unix;
  };
}
