#pragma once

/*  Resource ids shared between InstallerMain.cpp and the generated payload .rc.

    Plain #defines with no C++ in the file, because the Windows resource compiler reads
    this header too and understands nothing else.
*/

#define IDR_VST3_PAYLOAD      101
#define IDR_ICON_PAYLOAD      102
#define IDR_EULA_TEXT         103
#define IDR_MANUAL_TEXT       104
#define IDR_THIRDPARTY_TEXT   105
#define IDR_STANDALONE_PAYLOAD 106
