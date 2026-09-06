/**
 * Nix packaging for the Snap CLI (TypeScript implementation).
 *
 *   nix run  .#snap -- --version          # try without installing
 *   nix profile install .#snap            # install as `snap` (~/.nix-profile/bin)
 *
 * The build reproduces `./run`'s ts path: `npm ci` the lockfile, then
 * esbuild-bundle `src/main.ts` into a single self-contained `dist/main.mjs`
 * (the bundle pulls in the `effect` runtime deps; the entry needs nothing
 * but Node builtins at runtime). The installed `snap` is a thin wrapper
 * around `node <store>/lib/snap/main.mjs`, so the package ships no
 * node_modules and makes no PATH assumptions.
 */

{
  description = "Snap — deterministic replay version control (TypeScript implementation)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./nix/snap.nix {
          nodejs = pkgs.nodejs_22;
          src = pkgs.lib.cleanSourceWith {
            src = ./ts;
            # node_modules and dist are build outputs, never inputs.
            filter =
              path: _type:
              !(pkgs.lib.elem (baseNameOf path) [
                "node_modules"
                "dist"
                "result"
              ]);
          };
        };
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.system}.default}/bin/snap";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22 # node + npm, matching @types/node ^22
          ];
        };
      });
    };
}
