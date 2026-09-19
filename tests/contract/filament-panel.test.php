<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

require __DIR__ . '/../../laravel/vendor/autoload.php';

$app = require __DIR__ . '/../../laravel/bootstrap/app.php';
$panel = Filament\Facades\Filament::getPanel('admin');

if ($panel->getPath() !== 'next') {
    fwrite(STDERR, "expected panel path next, got {$panel->getPath()}\n");
    exit(1);
}

$route = collect(app('router')->getRoutes()->getRoutes())
    ->first(static fn (Illuminate\Routing\Route $route): bool => $route->uri() === 'next');

if ($route === null || $route->methods() !== ['GET', 'HEAD']) {
    fwrite(STDERR, "expected a GET/HEAD route at /next\n");
    exit(1);
}

fwrite(STDOUT, "Filament panel contract passed\n");
