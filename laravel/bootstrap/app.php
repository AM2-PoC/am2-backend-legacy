<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(then: static function (): void {
        Route::group([], __DIR__ . '/../routes/web.php');
    })
    ->withMiddleware(static function (Middleware $middleware): void {
    })
    ->withExceptions(static function (Exceptions $exceptions): void {
    })
    ->create();