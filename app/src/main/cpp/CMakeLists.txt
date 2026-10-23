# Vani AI - native bridge build.
#
# Two third-party engines, both pulled in as git submodules (see .gitmodules at the
# repo root). Run `git submodule update --init --recursive` before building.
#
#   llama.cpp   -> the LLM (LFM 2.5 350M, Qwen 3.5 0.8B, ...)
#   sherpa-onnx -> streaming STT + Silero VAD + offline ONNX-Runtime TTS
#
# Using sherpa-onnx for all three audio engines means a single .so and one copy of
# ONNX Runtime, instead of a separate ONNX Runtime JNI layer for VAD and TTS.

cmake_minimum_required(VERSION 3.22.1)

project(vani_ai LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Silence the upstream projects' warning-as-error defaults; they trip on Android's
# older NDK clang in ways that are irrelevant to Vani.
add_compile_options(-w)

# ---------------------------------------------------------------------------
# llama.cpp
# ---------------------------------------------------------------------------
set(LLAMA_BUILD_TESTS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER     OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON     OFF CACHE BOOL "" FORCE)
set(LLAMA_ALL_WARNINGS     OFF CACHE BOOL "" FORCE)
set(LLAMA_ALL_WARNINGS_3RD_PARTY OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_IS_DEV     OFF CACHE BOOL "" FORCE)

add_subdirectory(third_party/llama.cpp EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
# sherpa-onnx
# ---------------------------------------------------------------------------
set(SHERPA_ONNX_ENABLE_TESTS  OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_PYTHON OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_JNI    OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_C_API  ON  CACHE BOOL "" FORCE)

add_subdirectory(third_party/sherpa-onnx EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
# Vani JNI bridge
# ---------------------------------------------------------------------------
add_library(vani_jni SHARED vani_jni.cpp)

target_include_directories(vani_jni PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sherpa-onnx/sherpa-onnx/c-api/include
)

# llama.cpp may build libllama as SHARED or STATIC depending on BUILD_SHARED_LIBS;
# either way the target name is `llama`. sherpa-onnx's C API target is
# `sherpa-onnx-c-api`.
target_link_libraries(vani_jni PRIVATE llama sherpa-onnx-c-api)

# Android requires -fPIC / -fvisibility=hidden friendliness and strips the rest.
set_target_properties(vani_jni PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON
)

# Android's linker resolves JNI symbols against libvani_jni.so; keep them exported.
target_compile_options(vani_jni PRIVATE -fvisibility=default)
