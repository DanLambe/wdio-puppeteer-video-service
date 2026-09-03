Feature: Duplicate scenario names
  Scenario: cucumber style should record each same-named scenario
    Given I open the static video fixture
    Then I hold the first same-named scenario

  Scenario: cucumber style should record each same-named scenario
    Given I open the static video fixture
    Then I hold the second same-named scenario

  Scenario Outline: cucumber style should record each outline row
    Given I open the static video fixture
    Then I hold outline row "<row>"

    Examples:
      | row |
      | one |
      | two |
