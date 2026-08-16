cmake_minimum_required(VERSION 3.24)

project(LostDuckAntiFeedback VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set_property(GLOBAL PROPERTY USE_FOLDERS YES)

option(LOSTDUCK_DEV_SERVER    "Point the WebView at the Vite dev server instead of BinaryData" OFF)
option(LOSTDUCK_INSTALL_LOCAL "Also copy the built VST3 into C:/Program Files/Common Files/VST3" OFF)
option(LOSTDUCK_BUILD_HARNESS "Build the offline DSP measurement harness in tools/" OFF)
option(LOSTDUCK_BUILD_INSTALLER "Build the themed installer that carries the plug-in inside it" ON)

if(MSVC)
    add_compile_options(/utf-8 /permissive-)
endif()

# Where the built bundle is copied, and what it is called. One variable, because the
# name appears in the bundle path, the copy step and the install step.
set(LOSTDUCK_PLUGIN_OUTPUT "${CMAKE_CURRENT_SOURCE_DIR}/plugin")
set(LOSTDUCK_PRODUCT_NAME  "LOST DUCK Anti Feedback Ai")

# Names this build supersedes. Left in place they sit alongside the new bundle, the host
# lists both, and the user loads whichever they happen to click -- so the install step
# clears them out of both locations.
set(LOSTDUCK_OLD_PRODUCT_NAMES
    "LOST DUCK - NS1 remove"
    "LOST Duck Anti Feedback"
    "LOST DUCK Anti Feedback")

# ==============================================================================
#  ASIO (standalone only)
# ==============================================================================
# Steinberg will not let their SDK be redistributed or downloaded unattended, so it is
# not vendored and not fetched. Download it yourself from
# https://www.steinberg.net/developers/ , unzip it, and either drop it at
# third_party/asiosdk or configure with -DLOSTDUCK_ASIO_SDK_DIR=<path>.
#
# Without it the standalone still runs on WASAPI and DirectSound; ASIO just gets you
# from roughly 10-20 ms round trip down to 3-5 ms, which is the difference between a
# singer being able to use their in-ears comfortably and not.
set(LOSTDUCK_ASIO_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/asiosdk"
    CACHE PATH "Steinberg ASIO SDK root (the folder containing common/iasiodrv.h)")

set(LOSTDUCK_HAS_ASIO OFF)

if(WIN32 AND EXISTS "${LOSTDUCK_ASIO_SDK_DIR}/common/iasiodrv.h")
    set(LOSTDUCK_HAS_ASIO ON)
    message(STATUS "ASIO SDK found at ${LOSTDUCK_ASIO_SDK_DIR} -- standalone will offer ASIO")
elseif(WIN32)
    message(STATUS "No ASIO SDK at ${LOSTDUCK_ASIO_SDK_DIR} -- standalone limited to WASAPI/DirectSound")
endif()

configure_file(cmake/AssetPaths.h.in "${CMAKE_CURRENT_BINARY_DIR}/generated/AssetPaths.h" @ONLY)

# ==============================================================================
#  Licensing secret
# ==============================================================================
# Created once, on the first configure, and kept out of the source tree. Whoever holds
# this can mint keys, so it is generated locally rather than shipped or committed.
#
# CMake's string(RANDOM) is not a cryptographic generator. It is fine for getting
# started; before selling anything, replace the contents of licence-secret.txt with 64
# hex characters from a real source and rebuild. Note that doing so invalidates every
# key already issued.
set(LOSTDUCK_SECRET_FILE "${CMAKE_CURRENT_SOURCE_DIR}/cmake/licence-secret.txt")

if(NOT EXISTS "${LOSTDUCK_SECRET_FILE}")
    string(RANDOM LENGTH 64 ALPHABET "0123456789abcdef" LOSTDUCK_GENERATED_SECRET)
    file(WRITE "${LOSTDUCK_SECRET_FILE}" "${LOSTDUCK_GENERATED_SECRET}")
    message(STATUS "Generated a new licensing secret at cmake/licence-secret.txt -- back it up")
endif()

file(READ "${LOSTDUCK_SECRET_FILE}" LOSTDUCK_LICENCE_SECRET)
string(STRIP "${LOSTDUCK_LICENCE_SECRET}" LOSTDUCK_LICENCE_SECRET)
configure_file(cmake/LicenceSecret.h.in "${CMAKE_CURRENT_BINARY_DIR}/generated/LicenceSecret.h" @ONLY)

# The activation public key, baked in so the plug-in can verify tokens offline.
#
# Unlike the secret above, this half is public by definition and is committed. Reading it
# out of the binary buys an attacker nothing -- it verifies signatures, it cannot make
# them. The matching private key exists only in Supabase's secret store.
#
# Generate the pair with: node tools/make-activation-keys.mjs
set(LOSTDUCK_ACTIVATION_PUBLIC_FILE "${CMAKE_CURRENT_SOURCE_DIR}/cmake/activation-public-key.txt")

if(NOT EXISTS "${LOSTDUCK_ACTIVATION_PUBLIC_FILE}")
    message(FATAL_ERROR
        "cmake/activation-public-key.txt is missing. Without it the plug-in cannot verify "
        "any activation and every customer would be refused. Run: node tools/make-activation-keys.mjs")
endif()

file(READ "${LOSTDUCK_ACTIVATION_PUBLIC_FILE}" LOSTDUCK_ACTIVATION_PUBLIC_KEY)
string(STRIP "${LOSTDUCK_ACTIVATION_PUBLIC_KEY}" LOSTDUCK_ACTIVATION_PUBLIC_KEY)
configure_file(cmake/ActivationPublicKey.h.in
               "${CMAKE_CURRENT_BINARY_DIR}/generated/ActivationPublicKey.h" @ONLY)

# Windows shows a custom icon on a folder only when a desktop.ini points at one and the
# folder carries the system attribute. A .vst3 bundle is a folder, so that is how it
# gets an icon rather than anything in the VST3 spec.
set(LOSTDUCK_ICON_PNG   "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-lostduck.png")
set(LOSTDUCK_FOLDER_ICON "icon-lostduck-multi.ico")
set(LOSTDUCK_ICON_ICO   "${CMAKE_CURRENT_SOURCE_DIR}/assets/${LOSTDUCK_FOLDER_ICON}")
configure_file(cmake/desktop.ini.in "${CMAKE_CURRENT_BINARY_DIR}/generated/desktop.ini" @ONLY)

include(cmake/CPM.cmake)

CPMAddPackage(
    NAME JUCE
    GITHUB_REPOSITORY juce-framework/JUCE
    GIT_TAG 8.0.15
    GIT_SHALLOW TRUE
)

# ==============================================================================
#  React UI
# ==============================================================================
set(LOSTDUCK_UI_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/ui")
set(LOSTDUCK_UI_DIST "${LOSTDUCK_UI_DIR}/dist")

find_program(NPM_EXECUTABLE NAMES npm.cmd npm REQUIRED)

# JUCE ships the frontend half of the WebView bridge as plain JS; keep the copy
# in ui/src/juce in lock-step with the JUCE version CPM just fetched.
file(COPY "${JUCE_SOURCE_DIR}/modules/juce_gui_extra/native/javascript/"
     DESTINATION "${LOSTDUCK_UI_DIR}/src/juce")

if(NOT EXISTS "${LOSTDUCK_UI_DIR}/node_modules")
    message(STATUS "Installing UI dependencies (npm install)")
    execute_process(COMMAND "${NPM_EXECUTABLE}" install
                    WORKING_DIRECTORY "${LOSTDUCK_UI_DIR}"
                    RESULT_VARIABLE npm_install_result)
    if(NOT npm_install_result EQUAL 0)
        message(FATAL_ERROR "npm install failed in ${LOSTDUCK_UI_DIR}")
    endif()
endif()

# The BinaryData file list has to be known at configure time, so vite is pinned
# to these exact output names in ui/vite.config.ts.
set(LOSTDUCK_UI_FILES
    "${LOSTDUCK_UI_DIST}/index.html"
    "${LOSTDUCK_UI_DIST}/app.js"
    "${LOSTDUCK_UI_DIST}/app.css"
    "${LOSTDUCK_UI_DIST}/newcasing.svg"
    "${LOSTDUCK_UI_DIST}/button.svg"
    "${LOSTDUCK_UI_DIST}/btnnoise.svg"
    "${LOSTDUCK_UI_DIST}/noiseswitch on.svg"
    "${LOSTDUCK_UI_DIST}/noiseswitch off.svg"
    "${LOSTDUCK_UI_DIST}/indecator noise on.svg"
    "${LOSTDUCK_UI_DIST}/indecator noise off.svg"
    "${LOSTDUCK_UI_DIST}/sound effect/switch sound effect.mp3"
    "${LOSTDUCK_UI_DIST}/sound effect/bypass btn sound effect.mp3"
    "${LOSTDUCK_UI_DIST}/sound effect/knob sound effect.mp3")

file(GLOB_RECURSE LOSTDUCK_UI_SOURCES CONFIGURE_DEPENDS
     "${LOSTDUCK_UI_DIR}/src/*"
     "${LOSTDUCK_UI_DIR}/index.html"
     "${LOSTDUCK_UI_DIR}/vite.config.ts"
     "${LOSTDUCK_UI_DIR}/package.json"
     "${CMAKE_CURRENT_SOURCE_DIR}/assets/*")

foreach(missing IN LISTS LOSTDUCK_UI_FILES)
    if(NOT EXISTS "${missing}")
        message(STATUS "Building UI for the first time (npm run build)")
        execute_process(COMMAND "${NPM_EXECUTABLE}" run build
                        WORKING_DIRECTORY "${LOSTDUCK_UI_DIR}"
                        RESULT_VARIABLE npm_build_result)
        if(NOT npm_build_result EQUAL 0)
            message(FATAL_ERROR "npm run build failed in ${LOSTDUCK_UI_DIR}")
        endif()
        break()
    endif()
endforeach()

# Keeps `cmake --build` alone enough to refresh ui/dist.
add_custom_command(
    OUTPUT ${LOSTDUCK_UI_FILES}
    COMMAND "${NPM_EXECUTABLE}" run build
    WORKING_DIRECTORY "${LOSTDUCK_UI_DIR}"
    DEPENDS ${LOSTDUCK_UI_SOURCES}
    COMMENT "Building React UI (vite)"
    VERBATIM)

juce_add_binary_data(LostDuckUiData
    HEADER_NAME UiBinaryData.h
    NAMESPACE UiBinaryData
    SOURCES ${LOSTDUCK_UI_FILES})

set_target_properties(LostDuckUiData PROPERTIES
    POSITION_INDEPENDENT_CODE TRUE
    FOLDER "LostDuck")

# ==============================================================================
#  Plugin
# ==============================================================================
juce_add_plugin(LostDuckAntiFeedback
    COMPANY_NAME              "LOST"
    COMPANY_COPYRIGHT         "Copyright (c) 2026 LOST. Developed by noobkodak."
    COMPANY_WEBSITE           "https://lost.audio"
    PLUGIN_MANUFACTURER_CODE  Ldck
    # Changed from Ldnr, and the reason matters.
    #
    # A host identifies a VST3 by the UID these two codes generate, not by its filename.
    # FL Studio had Ldnr registered under the name of a bundle that had since been
    # renamed and deleted, so every rescan matched the new build to that dead record and
    # reported an error -- clearing its plug-in database did not help, because the record
    # lives in HKCU\Software\Image-Line\Shared\Plugins\Fruity Wrapper.
    #
    # A fresh code gives a fresh UID, so hosts treat this as a plug-in they have never
    # seen. The cost is that projects saved against Ldnr will not resolve to it; that is
    # the right trade here, because those projects were already failing to load it.
    PLUGIN_CODE               Ldai
    BUNDLE_ID                 "com.lostduck.antifeedback"
    FORMATS                   VST3 Standalone
    PRODUCT_NAME              "${LOSTDUCK_PRODUCT_NAME}"
    VST3_CATEGORIES           Fx Restoration
    IS_SYNTH                  FALSE
    NEEDS_MIDI_INPUT          FALSE
    NEEDS_MIDI_OUTPUT         FALSE
    IS_MIDI_EFFECT            FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD   FALSE
    NEEDS_WEBVIEW2            TRUE
    ICON_BIG                  "${LOSTDUCK_ICON_PNG}"
    ICON_SMALL                "${LOSTDUCK_ICON_PNG}")

target_sources(LostDuckAntiFeedback PRIVATE
    source/PluginProcessor.cpp
    source/PluginEditor.cpp
    source/DemoGate.cpp
    source/FeedbackGuard.cpp
    source/Activation.cpp
    source/Licence.cpp
    source/SpectralDenoiser.cpp
    source/WebResourceProvider.cpp)

target_include_directories(LostDuckAntiFeedback PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")

if(LOSTDUCK_HAS_ASIO)
    # JUCE compiles the driver interface itself; it only needs the headers on the path.
    target_include_directories(LostDuckAntiFeedback PUBLIC "${LOSTDUCK_ASIO_SDK_DIR}/common")
endif()

target_compile_definitions(LostDuckAntiFeedback PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_USE_CURL=0
    # The denoiser is our own code, compiled in. The plug-in hosts nothing, so the
    # hosting subsystem is off: less binary, and no scanner behaviour to inherit.
    JUCE_PLUGINHOST_VST3=0
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_AU=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_STRICT_REFCOUNTEDPOINTER=1
    JUCE_ASIO=$<BOOL:${LOSTDUCK_HAS_ASIO}>
    LOSTDUCK_DEV_SERVER=$<BOOL:${LOSTDUCK_DEV_SERVER}>)

target_link_libraries(LostDuckAntiFeedback PRIVATE
    LostDuckUiData
    juce::juce_audio_utils
    juce::juce_cryptography
    juce::juce_dsp
    juce::juce_gui_extra
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

set_target_properties(LostDuckAntiFeedback PROPERTIES FOLDER "LostDuck")

# ==============================================================================
#  Offline DSP harness
# ==============================================================================
if(LOSTDUCK_BUILD_HARNESS)
    juce_add_console_app(LostDuckDspHarness PRODUCT_NAME "LostDuckDspHarness")

    target_sources(LostDuckDspHarness PRIVATE
        tools/DspHarness.cpp
        source/FeedbackGuard.cpp)

    target_compile_definitions(LostDuckDspHarness PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STANDALONE_APPLICATION=1)

    target_link_libraries(LostDuckDspHarness PRIVATE
        juce::juce_audio_basics
        juce::juce_dsp
        juce::juce_core
        PUBLIC
        juce::juce_recommended_config_flags)

    set_target_properties(LostDuckDspHarness PROPERTIES FOLDER "LostDuck")

    # Additional Gain Before Feedback: the figure the product is actually judged on.
    juce_add_console_app(LostDuckAgbfBench PRODUCT_NAME "LostDuckAgbfBench")

    target_sources(LostDuckAgbfBench PRIVATE
        tools/AgbfBench.cpp
        source/FeedbackGuard.cpp
        source/SpectralDenoiser.cpp)

    target_compile_definitions(LostDuckAgbfBench PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STANDALONE_APPLICATION=1)

    target_link_libraries(LostDuckAgbfBench PRIVATE
        juce::juce_audio_basics
        juce::juce_dsp
        juce::juce_core
        PUBLIC
        juce::juce_recommended_config_flags)

    set_target_properties(LostDuckAgbfBench PROPERTIES FOLDER "LostDuck")

    # Puts the built plug-in through the same sequence a DAW's scanner uses, printing
    # each step first so a hang or a crash names the step it died on.
    juce_add_console_app(LostDuckValidate PRODUCT_NAME "LostDuckValidate")

    target_sources(LostDuckValidate PRIVATE tools/Validate.cpp)

    target_compile_definitions(LostDuckValidate PUBLIC
        JUCE_PLUGINHOST_VST3=1
        JUCE_PLUGINHOST_VST=0
        JUCE_PLUGINHOST_AU=0
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_MODAL_LOOPS_PERMITTED=1)

    target_link_libraries(LostDuckValidate PRIVATE
        juce::juce_audio_processors
        juce::juce_audio_utils
        juce::juce_gui_extra
        PUBLIC
        juce::juce_recommended_config_flags)

    set_target_properties(LostDuckValidate PROPERTIES FOLDER "LostDuck")

    # Drives the real Activation class against the real server, so an activation can be
    # tested in a second rather than by reinstalling the plug-in and opening a DAW.
    juce_add_console_app(LostDuckActivationProbe PRODUCT_NAME "LostDuckActivationProbe")

    target_sources(LostDuckActivationProbe PRIVATE
        tools/ActivationProbe.cpp
        source/Activation.cpp)

    target_include_directories(LostDuckActivationProbe PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")

    target_compile_definitions(LostDuckActivationProbe PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STANDALONE_APPLICATION=1)

    target_link_libraries(LostDuckActivationProbe PRIVATE
        juce::juce_core
        juce::juce_cryptography
        juce::juce_data_structures
        juce::juce_events
        PUBLIC
        juce::juce_recommended_config_flags)

    set_target_properties(LostDuckActivationProbe PROPERTIES FOLDER "LostDuck")

    # Mints licence keys. Compiles Licence.cpp directly so the generator and the plug-in
    # can never disagree about what a valid key is.
    juce_add_console_app(LostDuckKeyGen PRODUCT_NAME "LostDuckKeyGen")

    # Only Licence.cpp: the generator mints keys and has no business talking to an
    # activation server, so it deliberately does not compile Activation.cpp.
    target_sources(LostDuckKeyGen PRIVATE
        tools/KeyGen.cpp
        source/Licence.cpp)

    target_include_directories(LostDuckKeyGen PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")

    target_compile_definitions(LostDuckKeyGen PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STANDALONE_APPLICATION=1)

    target_link_libraries(LostDuckKeyGen PRIVATE
        juce::juce_core
        juce::juce_cryptography
        juce::juce_data_structures
        juce::juce_events
        PUBLIC
        juce::juce_recommended_config_flags)

    set_target_properties(LostDuckKeyGen PROPERTIES FOLDER "LostDuck")
endif()

# ==============================================================================
#  Installer
# ==============================================================================
# A GUI app wearing the plug-in's own casing, with the plug-in itself carried inside it
# as a Win32 RCDATA resource so the download is a single file.
if(LOSTDUCK_BUILD_INSTALLER AND WIN32)
    set(LOSTDUCK_INSTALLER_WEB "${CMAKE_CURRENT_SOURCE_DIR}/installer/web")

    # Hand-written rather than built by vite: the installer is four screens and a button,
    # and a second bundler entry point would have to fight the plug-in's fixed output
    # filenames for no gain.
    juce_add_binary_data(LostDuckInstallerUiData
        HEADER_NAME InstallerUiData.h
        NAMESPACE InstallerUiData
        SOURCES
            "${LOSTDUCK_INSTALLER_WEB}/index.html"
            "${LOSTDUCK_UI_DIR}/src/juce/index.js"
            "${LOSTDUCK_UI_DIR}/src/juce/check_native_interop.js"
            "${CMAKE_CURRENT_SOURCE_DIR}/assets/newcasing.svg"
            "${CMAKE_CURRENT_SOURCE_DIR}/assets/button.svg"
            "${CMAKE_CURRENT_SOURCE_DIR}/assets/logolostduck.png")

    set_target_properties(LostDuckInstallerUiData PROPERTIES
        POSITION_INDEPENDENT_CODE TRUE
        FOLDER "LostDuck")

    juce_add_gui_app(LostDuckInstaller
        PRODUCT_NAME              "${LOSTDUCK_PRODUCT_NAME} Installer"
        COMPANY_NAME              "LOST"
        COMPANY_COPYRIGHT         "Copyright (c) 2026 LOST. Developed by noobkodak."
        BUNDLE_ID                 "com.lostduck.antifeedback.installer"
        NEEDS_WEBVIEW2            TRUE
        ICON_BIG                  "${LOSTDUCK_ICON_PNG}"
        ICON_SMALL                "${LOSTDUCK_ICON_PNG}")

    target_sources(LostDuckInstaller PRIVATE installer/InstallerMain.cpp)

    # The payload references the built VST3 by path. Written with file(GENERATE) rather
    # than configure_file because only a generator expression knows where a multi-config
    # build actually put it; add_dependencies below guarantees it exists before rc runs.
    file(GENERATE
        OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/payload-$<CONFIG>.rc"
        CONTENT
"#include \"${CMAKE_CURRENT_SOURCE_DIR}/installer/PayloadIds.h\"

IDR_VST3_PAYLOAD       RCDATA \"$<TARGET_FILE:LostDuckAntiFeedback_VST3>\"
IDR_STANDALONE_PAYLOAD RCDATA \"$<TARGET_FILE:LostDuckAntiFeedback_Standalone>\"
IDR_ICON_PAYLOAD    RCDATA \"${LOSTDUCK_ICON_ICO}\"
IDR_EULA_TEXT       RCDATA \"${CMAKE_CURRENT_SOURCE_DIR}/installer/EULA.txt\"
IDR_MANUAL_TEXT     RCDATA \"${CMAKE_CURRENT_SOURCE_DIR}/MANUAL.md\"
IDR_THIRDPARTY_TEXT RCDATA \"${CMAKE_CURRENT_SOURCE_DIR}/THIRD-PARTY.txt\"
")

    target_sources(LostDuckInstaller PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/payload-$<CONFIG>.rc")

    target_include_directories(LostDuckInstaller PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/installer")

    target_compile_definitions(LostDuckInstaller PUBLIC
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
        JUCE_USE_CURL=0
        JUCE_DISPLAY_SPLASH_SCREEN=0
        JUCE_STRICT_REFCOUNTEDPOINTER=1)

    target_link_libraries(LostDuckInstaller PRIVATE
        LostDuckInstallerUiData
        juce::juce_gui_extra
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

    # The VST3 folder is under Program Files, so ask Windows for elevation up front
    # rather than failing partway through writing the bundle.
    target_link_options(LostDuckInstaller PRIVATE
        "/MANIFESTUAC:level='requireAdministrator' uiAccess='false'")

    add_dependencies(LostDuckInstaller
        LostDuckAntiFeedback_VST3
        LostDuckAntiFeedback_Standalone)
    set_target_properties(LostDuckInstaller PROPERTIES FOLDER "LostDuck")

    # Dropped next to the staged bundle, which is what gets uploaded.
    add_custom_command(TARGET LostDuckInstaller POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${LOSTDUCK_PLUGIN_OUTPUT}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "$<TARGET_FILE:LostDuckInstaller>"
                "${LOSTDUCK_PLUGIN_OUTPUT}/${LOSTDUCK_PRODUCT_NAME} Installer.exe"
        COMMENT "Copying installer to plugin/"
        VERBATIM)
endif()

# ==============================================================================
#  Deployment
# ==============================================================================
# The bundle used to carry a desktop.ini and be marked +s so Explorer would draw the duck
# on the folder. That is gone, and deliberately.
#
# A .vst3 bundle is a folder a host walks. Ours was the only one of 226 in the VST3
# directory carrying the System attribute and an extra file at its root, and FL Studio
# would not verify it while every other plug-in there passed. A folder icon is not worth
# being the odd one out in somebody's plug-in scanner: hosts are the audience for this
# directory, not Explorer.
#
# The icon still ships -- the installer puts it beside the manual, where nothing scans.
# Removed before copying, never copied over the top.
#
# Windows keeps a folder's existing attributes and a file's existing capitalisation when
# something is copied onto it. After the rename that left a bundle called
# "LOST DUCK Anti Feedback.vst3" whose inner binary was still "LOST Duck Anti
# Feedback.vst3", and the VST3 layout requires those to match. Deleting first is the only
# way to be sure the destination is exactly what was just built.
add_custom_command(TARGET LostDuckAntiFeedback_VST3 POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${LOSTDUCK_PLUGIN_OUTPUT}"
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${LOSTDUCK_PLUGIN_OUTPUT}/${LOSTDUCK_PRODUCT_NAME}.vst3"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "$<TARGET_FILE_DIR:LostDuckAntiFeedback_VST3>/../.."
            "${LOSTDUCK_PLUGIN_OUTPUT}/${LOSTDUCK_PRODUCT_NAME}.vst3"
    COMMENT "Copying VST3 bundle to plugin/"
    VERBATIM)

if(LOSTDUCK_INSTALL_LOCAL)
    set(LOSTDUCK_INSTALLED "C:\\Program Files\\Common Files\\VST3\\${LOSTDUCK_PRODUCT_NAME}.vst3")

    # Same reasoning as above: the old bundle goes, then the new one lands clean. This
    # also clears the System attribute and stray desktop.ini earlier builds left behind.
    add_custom_command(TARGET LostDuckAntiFeedback_VST3 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E rm -rf
                "C:/Program Files/Common Files/VST3/${LOSTDUCK_PRODUCT_NAME}.vst3"
        COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${LOSTDUCK_PLUGIN_OUTPUT}/${LOSTDUCK_PRODUCT_NAME}.vst3"
                "C:/Program Files/Common Files/VST3/${LOSTDUCK_PRODUCT_NAME}.vst3"
        COMMENT "Installing VST3 to the system scan folder"
        VERBATIM)

    # A renamed bundle does not replace the old one, it sits next to it. Left alone, the
    # host lists both and the user loads whichever they happen to click.
    string(TOLOWER "${LOSTDUCK_PRODUCT_NAME}" LOSTDUCK_PRODUCT_NAME_LOWER)

    foreach(oldName IN LISTS LOSTDUCK_OLD_PRODUCT_NAMES)
        # Compared case-insensitively because Windows paths are. "LOST Duck Anti
        # Feedback" and "LOST DUCK Anti Feedback" are two spellings of one folder, and a
        # case-sensitive STREQUAL let the rm step delete the bundle just installed.
        string(TOLOWER "${oldName}" oldNameLower)

        if(NOT oldNameLower STREQUAL LOSTDUCK_PRODUCT_NAME_LOWER)
            add_custom_command(TARGET LostDuckAntiFeedback_VST3 POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E rm -rf
                        "C:/Program Files/Common Files/VST3/${oldName}.vst3"
                COMMAND ${CMAKE_COMMAND} -E rm -rf
                        "${LOSTDUCK_PLUGIN_OUTPUT}/${oldName}.vst3"
                COMMENT "Removing superseded bundle: ${oldName}.vst3"
                VERBATIM)
        endif()
    endforeach()
endif()
