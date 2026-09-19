<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;

require __DIR__ . '/../../laravel/vendor/autoload.php';

$app = require __DIR__ . '/../../laravel/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->handle(Request::create('/next/health', 'GET'));

$panel = Filament\Facades\Filament::getPanel('admin');
if ($panel === null) {
    fwrite(STDERR, "Filament panel admin is not registered\n");
    exit(1);
}

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
