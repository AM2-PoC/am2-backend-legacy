<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

use Illuminate\Contracts\Http\Kernel;

try {
    require __DIR__ . '/../../laravel/vendor/autoload.php';
    $app = require __DIR__ . '/../../laravel/bootstrap/app.php';
    $kernel = $app->make(Kernel::class);
    $kernel->bootstrap();

$panels = Filament\Facades\Filament::getPanels();
if (! array_key_exists('admin', $panels)) {
    fwrite(STDERR, "Filament panel admin is not registered\n");
    exit(1);
}
$panel = $panels['admin'];

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
} catch (Throwable $error) {
    fwrite(STDERR, $error . "\n");
    exit(1);
}
