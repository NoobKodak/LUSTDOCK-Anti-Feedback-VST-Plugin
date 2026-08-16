#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include <optional>

namespace lostduck
{
/** Serves the built React app (ui/dist, compiled into BinaryData) to the WebView. */
std::optional<juce::WebBrowserComponent::Resource> getWebResource (const juce::String& url);
}
