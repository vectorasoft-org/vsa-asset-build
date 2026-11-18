<?php

namespace Vsd\AssetBuild;

/*
 | The PHP side of the builder: WHERE things are, and WHETHER this box can run
 | them. It runs nothing itself - `php artisan vsa:deploy` owns the sequence and
 | the output - so that a deploy's steps are all visible in one place.
 |
 | The build itself is Node (esbuild). This package travels to a server through
 | composer, with the credential the box already has for every other vsd/*
 | package, and its one Node dependency - esbuild - is PUBLIC on npm. So a
 | server needs no git credentials and no private npm registry: composer brings
 | the code, `npm ci` in the PROJECT ROOT brings the binary.
 |
 | esbuild lives in the PROJECT's node_modules, never under vendor/: composer
 | rewrites vendor/ on every deploy and would take node_modules with it.
 */
class AssetBuild
{
    /** This package's own folder. */
    public static function packageRoot(): string
    {
        return dirname(__DIR__);
    }

    /** The Node entry point a deploy runs: `node <this> --root=<project>`. */
    public static function entry(): string
    {
        return self::packageRoot() . '/bin/build.js';
    }

    /** The pinned esbuild version this builder is written against. */
    public static function esbuildVersion(): string
    {
        $json = json_decode((string) @file_get_contents(self::packageRoot() . '/package.json'), true);
        return (string) ($json['peerDependencies']['esbuild'] ?? '');
    }

    /**
     * Is esbuild installed in the project, for THIS platform? esbuild ships a
     * native binary per platform, so a node_modules copied from a Mac is the
     * one failure that reads as a broken build rather than a wrong binary.
     */
    public static function esbuildInstalled(string $projectRoot): bool
    {
        return is_file($projectRoot . '/node_modules/esbuild/package.json');
    }

    /** Does the project declare the dependency at all (package.json + lockfile)? */
    public static function projectDeclaresEsbuild(string $projectRoot): bool
    {
        $json = json_decode((string) @file_get_contents($projectRoot . '/package.json'), true);
        if (! is_array($json)) return false;
        foreach (['dependencies', 'devDependencies'] as $k) {
            if (! empty($json[$k]['esbuild'])) return true;
        }
        return false;
    }

    /** The command a deploy runs to build and publish this project's assets. */
    public static function command(string $projectRoot, array $options = []): string
    {
        $parts = ['node', escapeshellarg(self::entry()), '--root=' . escapeshellarg($projectRoot)];
        foreach ($options as $o) $parts[] = $o;
        return implode(' ', $parts);
    }
}
