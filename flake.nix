{
  description = "Development shell for herb (C parser, wasm build, Ruby gem, JS packages)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs:
        let
          llvm = pkgs.llvmPackages_21;

          # The Makefile's Linux branch calls versioned binaries (clang-21, ...), as Debian names them.
          versioned = name: target:
            pkgs.writeShellScriptBin "${name}-21" ''exec ${target} "$@"'';
        in
        {
          default = pkgs.mkShell {
            packages = [
              # Versions follow .ruby-version, .node-version, and the Brewfile/Aptfile.
              pkgs.ruby_4_0
              pkgs.nodejs_24
              pkgs.yarn

              llvm.clang
              llvm.clang-tools
              (versioned "clang" "${llvm.clang}/bin/clang")
              (versioned "clang-format" "${llvm.clang-tools}/bin/clang-format")
              (versioned "clang-tidy" "${llvm.clang-tools}/bin/clang-tidy")

              pkgs.emscripten
              pkgs.gnumake
              pkgs.pkg-config
              pkgs.check
              pkgs.doxygen
              pkgs.python314
              pkgs.gh
              pkgs.jq

              # Headers and libraries for native gem extensions.
              pkgs.libyaml
              pkgs.libffi
              pkgs.openssl
              pkgs.zlib
            ];
          };
        });
    };
}
