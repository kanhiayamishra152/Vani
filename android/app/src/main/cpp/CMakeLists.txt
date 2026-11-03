cmake_minimum_required(VERSION 3.22)
project(vani_llama LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED LLAMA_DIR)
    message(FATAL_ERROR "LLAMA_DIR must point at the pinned llama.cpp source (scripts/fetch-native-deps.mjs)")
endif()
if(NOT EXISTS "${LLAMA_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "llama.cpp source missing at ${LLAMA_DIR} — run: node scripts/fetch-native-deps.mjs")
endif()

# Lean, CPU-only, shared-library build for Android arm64-v8a.
set(BUILD_SHARED_LIBS        ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON       ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS        OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS        OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES     OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER       OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP          OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_HTML         OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL               OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL            OFF CACHE BOOL "" FORCE)
set(LLAMA_SUBPROCESS         OFF CACHE BOOL "" FORCE)
set(LLAMA_LLGUIDANCE         OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE              OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP              OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_TESTS         OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_EXAMPLES      OFF CACHE BOOL "" FORCE)
set(GGML_CCACHE              OFF CACHE BOOL "" FORCE)
set(MTMD_VIDEO               OFF CACHE BOOL "" FORCE)

# v1.3.0 PocketPal-class CPU tuning for Snapdragon 4 Gen 2 (2x Cortex-A78 + 6x
# Cortex-A55): ARMv8.2-A with dot-product + FP16 arithmetic, tuned for the A78
# performance cores, aggressive inlining/unrolling and no debug assertions.
# Applied globally so ggml/llama.cpp inherit the same instruction set.
if(ANDROID AND ANDROID_ABI STREQUAL "arm64-v8a")
    add_compile_options(-O3 -march=armv8.2-a+dotprod+fp16 -mtune=cortex-a78 -funroll-loops -DNDEBUG)
endif()

add_subdirectory("${LLAMA_DIR}" llama-build)
add_subdirectory("${LLAMA_DIR}/tools/mtmd" mtmd-build)

add_library(vani_llama SHARED vani_llama.cpp)
target_link_libraries(vani_llama PRIVATE llama llama-common mtmd)
if(ANDROID)
    target_link_libraries(vani_llama PRIVATE log android)
endif()
target_compile_options(vani_llama PRIVATE -O3 -fexceptions -frtti -DNDEBUG)
