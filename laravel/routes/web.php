<?php

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Route;

Route::get('/next/health', static fn (): JsonResponse => response()->json(['status' => 'ok']));